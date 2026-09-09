#include "mirrorgate/control.hpp"
#include "mirrorgate/managed_worker.hpp"
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
using mirrorgate::Json;
using mirrorgate::ControlClient;
void require(bool ok,const char* message){if(!ok)throw std::runtime_error(message);}
std::string read(const std::string& file){std::ifstream in(file);std::ostringstream out;out<<in.rdbuf();require(bool(in),"Cannot read fixture");return out.str();}
int main(int argc,char** argv){
  try {
    require(argc==6,"Expected mode, fixture/socket, root, manifest, submit/wait");
    std::string mode=argv[1],entry=argv[2],root=argv[3],host=argv[5];
    auto connect=[&](){return mode=="stdio" ?
      ControlClient::launch({"/usr/bin/python3",entry,"stdio",root,host},{},std::chrono::seconds(5),2) :
      ControlClient::connect(entry,{},std::chrono::seconds(5),2);};
    auto control=connect();require(control->owns_process()==(mode=="stdio"),"Incorrect process ownership");
    auto manifest_json=read(argv[4]);
    auto session=control->open_session({{"policyId","test.node"},{"runtime","node-v1"},{"manifestJson",manifest_json},
      {"submission",{{"kind","source"},{"input",{{"rootId","submission"},{"relativePath","source"}}},{"buildPlanId","copy"},{"authoring",true}}}});
    require(session.agent_status().is_null(),"Run exists before start");
    auto run=session.start_agent("author",{{"instructions","Implement public Counter"},{"files",Json::array()}});
    // Foreign same-UID connection must be rejected by the real controller.
    auto foreign=connect();
    for(const std::string op:{"agent.status","agent.cancel"}) {
      Json args={{"sessionId",session.id()},{"runId",run.id()}};
      if(op=="agent.cancel")args["reason"]="user-cancel";
      bool denied=false;try{foreign->request(op,args);}catch(const mirrorgate::SdkError& e){denied=e.code=="HANDLE_INVALID";}
      require(denied,"Foreign handle was accepted");
    }
    foreign->close();
    Json result;
    if(host=="wait") {
      result=run.cancel();
      require(result.at("outcome")=="cancelled" && !result.contains("submission"),"Cancelled run retained source");
    } else {
      result=run.wait(std::chrono::seconds(10));
      require(result.at("outcome")=="submitted","Synthetic author did not submit");
      require(session.status().at("phase")=="submitted","Missing submitted phase");
      // Live source mutation cannot affect committed build.
      {std::ofstream file(root+"/source/adapter.mjs");file<<"throw new Error('live mutation must not run');\n";}
      require(run.cancel().at("submission")==result.at("submission"),"Postcommit cancel replaced source identity");
      auto prepared=session.prepare().wait();
      require(prepared.at("sourceHash")==result.at("submission").at("sourceHash"),"Prepared a different source");
      auto manifest=mirrorgate::Manifest::parse(manifest_json);
      Json attestation={{"registrationId","native-hosting"},{"request","verify"},{"policy","require"},{"status","matched"},
        {"descriptorSchema","mirrors.model-interface-descriptor/v1"},{"semanticDigest",manifest.interface_digest()},
        {"adapterId","mirrorgate/node-v1"},{"targetProfile","node-v1"},{"stateComputerContractVersion","mirrors.state-computer/v1"}};
      auto auth=session.authorize(prepared.at("preparedRevision"),prepared.at("challenge"),attestation);
      auto descriptor=session.acquire_worker(auth);require(descriptor.release_mode()=="control-v1","Worker attachment contract changed");
      auto worker=mirrorgate::ManagedWorker::attach(session,descriptor,std::move(manifest),"node-v1");
      worker->invoke("Initialize",{});
      require(worker->observe().at("Count").text=="0","Frozen Counter initial observation wrong");
      worker->invoke("Tick",{{"Stride",mirrorgate::NativeValue::bigint("3")}});
      require(worker->observe().at("Count").text=="3","Frozen Counter observation wrong");
      worker->close();
    }
    require(result.at("cleanup").at("status")=="succeeded" && result.at("cleanup").at("remainingResources").empty(),"Host cleanup not confirmed");
    auto cleanup=session.close().wait();require(cleanup.at("phase")=="closed","Session cleanup failed");
    control->close();
    if(mode=="unix") {auto still_alive=connect();require(!still_alive->owns_process(),"Attached client stopped daemon");still_alive->close();}
    std::cout<<"C++ real controller / synthetic author "<<mode<<" "<<host<<" passed (actual backend; synthetic runtime admission)\n";
  }catch(const std::exception& e){std::cerr<<e.what()<<"\n";return 1;}
}
