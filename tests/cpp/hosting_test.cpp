#include "mirrorgate/control.hpp"
#include <fstream>
#include <iostream>
#include <stdexcept>
using mirrorgate::Json;
using mirrorgate::SdkError;
void require(bool value,const std::string& message) {if(!value)throw std::runtime_error(message);}
std::string terminal(const Json& v) {
  auto op=v.value("operation","");
  return op.empty() ? "" : op=="session.prepare" ? "Prepared" : op=="authoring.exec" ? "CommandResult" : "CleanupResult";
}
class Script final : public mirrorgate::Transport {
 public:
  std::vector<Json> replies,writes;
  std::vector<std::chrono::milliseconds> timeouts;
  std::size_t at=0;bool closed=false;
  void write_frame(const std::string& payload,std::size_t) override {writes.push_back(Json::parse(payload));}
  std::string read_frame(std::size_t,std::chrono::milliseconds timeout) override {
    timeouts.push_back(timeout);
    if(at>=replies.size())throw SdkError("CONTROL_DISCONNECTED","End of script");
    return replies[at++].dump();
  }
  void close() noexcept override {closed=true;}
  bool owns_process() const noexcept override {return false;}
};
void client_tests(const std::map<std::string,Json>& corpus) {
  auto value=[&](const char* name){return corpus.at(name).at("value");};
  auto response=[](Json v,int id){v["id"]=id;return v;};
  auto open_args=value("v2-base-open-source-request").at("args");
  auto task=value("start").at("args").at("publicTask");
  for(int failure=0;failure<5;++failure) {
    auto transport=new Script;
    transport->replies={value("hosting-bootstrap-selected"),response(value("v2-base-session-opened"),2),response(value("accepted-run"),3)};
    auto event=value("agent.updated");
    if(failure==1)event["data"]["run"]["runId"]=std::string(32,'9');
    if(failure==2)event["sessionId"]=std::string(32,'9');
    transport->replies.push_back(event);
    auto status=response(value("running"),4);
    if(failure==3)status["result"]["run"]["phase"]="starting";
    if(failure==4)status["result"]["run"]["runId"]=std::string(32,'9');
    transport->replies.push_back(status);
    transport->replies.push_back(response(value("cancel-after-submit"),5));
    auto client=mirrorgate::ControlClient::from_transport(std::unique_ptr<mirrorgate::Transport>(transport),{},std::chrono::seconds(5),2);
    require(transport->writes[0].at("v")==1 && transport->writes[0].at("args").at("controlVersions")==Json::array({2}),"Wrong bootstrap");
    auto session=client->open_session(open_args);auto run=session.start_agent("author",task);
    bool rejected=false;
    try {require(run.status().at("phase")=="running","Wrong run status");}catch(const SdkError&){rejected=true;}
    require(rejected==(failure!=0),"Stateful malformed run accepted");
    if(failure) {require(transport->closed,"Malformed connection not closed");continue;}
    require(run.cancel().at("outcome")=="submitted","Postcommit cancellation lost source");
    require(transport->timeouts.back().count()>=6998,"Cancellation timeout less than cleanup join");
    require(transport->writes[1].at("v")==2,"Posthello request did not switch to v2");
    auto other_transport=new Script;
    auto other_open=response(value("v2-base-session-opened"),2);other_open["result"]["sessionId"]=std::string(32,'8');
    other_transport->replies={value("hosting-bootstrap-selected"),other_open};
    auto other=mirrorgate::ControlClient::from_transport(std::unique_ptr<mirrorgate::Transport>(other_transport),{},std::chrono::seconds(5),2);
    auto other_session=other->open_session(open_args);
    for(int which=0;which<2;++which) {
      bool denied=false;try {if(which)other_session.cancel_agent(run);else other_session.agent_status(run);}catch(const SdkError& e){denied=e.code=="HANDLE_INVALID";}
      require(denied && other_transport->writes.size()==2,"Foreign run handle reached transport");
    }
    client->close();
    bool denied=false;try{run.status();}catch(const SdkError&e){denied=e.code=="HANDLE_INVALID";}
    require(denied,"Closed owner run remained usable");
  }
  // No downgrade when v2 was offered alone.
  auto transport=new Script;auto hello=value("hosting-bootstrap-selected");hello["result"]["controlVersion"]=1;
  transport->replies={hello};bool denied=false;
  try{mirrorgate::ControlClient::from_transport(std::unique_ptr<mirrorgate::Transport>(transport),{},std::chrono::seconds(5),2);}catch(const SdkError&){denied=true;}
  require(denied,"Hosting silently downgraded");
}

int main(int argc,char** argv) {
  try {
    require(argc==2,"Expected vector file");
    std::ifstream input(argv[1]);require(bool(input),"Missing vectors");
    std::string line;std::size_t count=0;std::map<std::string,Json> corpus;
    while(std::getline(input,line)) {
      auto vector=Json::parse(line);corpus[vector.at("name")]=vector;bool valid=true;
      try {
        const auto& value=vector.at("value");auto kind=vector.at("kind").get<std::string>();
        if(kind=="request")mirrorgate::validate_control_v2_request(value);
        else if(kind=="response")mirrorgate::validate_control_v2_response(value,vector.at("request"),terminal(vector));
        else if(kind=="event")mirrorgate::validate_control_v2_event(value,terminal(vector));
        else if(kind=="operation")mirrorgate::validate_control_operation_fixture(value,terminal(vector));
        else throw std::runtime_error("Unsupported shared vector kind");
      }catch(const std::exception&) {valid=false;}
      require(valid==vector.at("valid").get<bool>(),"V2 vector mismatch: "+vector.at("name").get<std::string>());
      ++count;
    }
    client_tests(corpus);
    require(count>=115,"Incomplete shared v2 corpus");
    std::cout<<"C++ control v2 shared vectors passed: "<<count<<"\n";
  }catch(const std::exception& e) {std::cerr<<e.what()<<"\n";return 1;}
}
