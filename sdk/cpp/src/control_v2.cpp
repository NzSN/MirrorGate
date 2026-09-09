#include "mirrorgate/control.hpp"

#include <algorithm>
#include <map>
#include <regex>
#include <set>

namespace mirrorgate {
namespace {
constexpr JsonLimits bounds{1048576, 128, 16384};
const std::map<std::string, std::uint64_t> ceilings{{"wallMs",300000},
  {"stdoutBytes",1048576},{"stderrBytes",1048576},{"progressRecords",256},
  {"progressBytes",262144},{"progressRecordBytes",16384}};
void check(bool valid, const char* message) {
  if (!valid) throw SdkError("CONTROL_MALFORMED", message);
}
void version(const Json& value, int expected) {
  check(value.contains("v") && value.at("v").is_number_integer() && value.at("v") == expected,
        "Wrong control version");
}
std::string string(const Json& value, const char* key, std::size_t max, bool nonempty = true) {
  auto out = require_string(value, key, max);
  check(!nonempty || !out.empty(), "Empty string");
  return out;
}
void handle(const Json& value, const char* key) {
  check(std::regex_match(string(value,key,32), std::regex("^[0-9a-f]{32}$")), "Invalid handle");
}
void error(const Json& value) {
  require_exact_fields(value,{"code","stage","message"},{"operationId"});
  auto normalized = value;
  const auto code = string(value,"code",64);
  if (code == "AGENT_START_FAILED" || code == "AGENT_EXITED" || code == "AUDIT_UNAVAILABLE")
    normalized["code"] = "WORKER_EXITED";
  if (string(value,"stage",32) == "hosting") normalized["stage"] = "worker";
  validate_control_response_fixture({{"v",1},{"kind","response"},{"id",1},{"ok",false},{"error",normalized}},"session.status");
}
void limits(const Json& value, bool complete) {
  std::vector<std::string> names;
  for (const auto& item : ceilings) names.push_back(item.first);
  require_exact_fields(value, complete ? names : std::vector<std::string>{}, complete ? std::vector<std::string>{} : names);
  for (const auto& item : value.items())
    check(require_safe_id(value,item.key().c_str()) <= ceilings.at(item.key()), "Hosting limit exceeds ceiling");
}
void public_task(const Json& value) {
  require_exact_fields(value,{"instructions","files"});
  string(value,"instructions",65536);
  const auto& files=value.at("files");
  check(files.is_array() && files.size()<=128,"Invalid public files");
  std::set<std::string> paths;
  std::size_t total=0;
  for (const auto& file:files) {
    require_exact_fields(file,{"path","text"});
    auto path=string(file,"path",1024);
    check(path.front()!='/' && path.back()!='/' && path.find('\\')==std::string::npos &&
      path.find('\0')==std::string::npos,"Invalid public path");
    std::size_t begin=0;
    while (begin<path.size()) {
      auto end=path.find('/',begin);
      auto part=path.substr(begin,end==std::string::npos ? path.size()-begin : end-begin);
      check(!part.empty() && part!="." && part!=".." && !(begin==0 && part==".mirrorgate"),"Unsafe public path");
      if(end==std::string::npos) break;
      begin=end+1;
    }
    for(const auto& existing:paths)
      check(path!=existing && path.compare(0,existing.size()+1,existing+"/")!=0 &&
        existing.compare(0,path.size()+1,path+"/")!=0,"Colliding public paths");
    paths.insert(path);
    total+=string(file,"text",262144,false).size();
    check(total<=262144,"Public file bytes exceeded");
  }
}
void legacy_hello(const Json& value) {
  const auto& result=value.at("result");
  check(result.at("capabilities").is_array() && result.at("capabilities").size()<=64,"Too many capabilities");
  const std::set<std::string> keys{"maxFrameBytes","maxJsonDepth","maxJsonNodes","maxPendingOutputBytes",
    "maxSessionsPerConnection","maxInflightRequestsPerConnection","maxCompletedOperationsPerSession",
    "helloTimeoutMs","requestAckTimeoutMs","workerAttachmentTimeoutMs","sessionWallMs","gracefulStopMs","teardownMs",
    "executionWallMs","commandCpuSeconds","addressSpaceBytes","uidProcesses","openFiles","fileBytes",
    "stdoutBytes","stderrBytes","snapshotFiles","snapshotBytes","tmpBytes","scratchBytes"};
  for(const auto& cap:result.at("capabilities"))
    for(const auto& limit:cap.at("limits").items()) check(keys.count(limit.key()),"Unknown capability limit");
}
} // namespace

void validate_hosted_run(const Json& run) {
  (void)encode_strict_json(run,bounds);
  require_exact_fields(run,{"runId","phase","cleanup","limits","progress"},{"outcome","submission","error"});
  handle(run,"runId");
  const auto phase=string(run,"phase",16);
  check(phase=="starting" || phase=="running" || phase=="submitting" || phase=="cleaning" || phase=="finished","Invalid run phase");
  limits(run.at("limits"),true);
  const auto& cleanup=run.at("cleanup");
  require_exact_fields(cleanup,{"status","remainingResources"});
  auto state=string(cleanup,"status",16);
  const auto& resources=cleanup.at("remainingResources");
  check(resources.is_array() && resources.size()<=64,"Invalid cleanup resources");
  std::set<std::string> seen;
  for(const auto& resource:resources) {
    check(resource.is_string(),"Invalid resource id");
    auto id=resource.get<std::string>();
    check(std::regex_match(id,std::regex("^[A-Za-z][A-Za-z0-9_.-]{0,127}$")) && seen.insert(id).second,"Invalid resource id");
  }
  const bool terminal=phase=="cleaning" || phase=="finished";
  check(terminal==run.contains("outcome"),"Run outcome disagrees with phase");
  check((phase=="finished" && (state=="succeeded" || state=="failed")) ||
    (phase=="cleaning" && state=="pending") || (!terminal && state=="notStarted"),"Incoherent run cleanup");
  check((state!="succeeded" && state!="notStarted") || resources.empty(),"Unexpected remaining resources");
  auto outcome=run.contains("outcome") ? string(run,"outcome",16) : "";
  check(!terminal || outcome=="submitted" || outcome=="failed" || outcome=="cancelled" || outcome=="timedOut","Invalid run outcome");
  check((outcome=="submitted")==run.contains("submission"),"Submission outcome mismatch");
  check((outcome=="failed" || outcome=="cancelled" || outcome=="timedOut")==run.contains("error"),"Run error mismatch");
  if(run.contains("error")) error(run.at("error"));
  if(run.contains("submission")) {
    const auto& sub=run.at("submission");
    require_exact_fields(sub,{"submissionId","sourceHash","sourceRevision"});
    handle(sub,"submissionId");
    check(std::regex_match(string(sub,"sourceHash",64),std::regex("^[0-9a-f]{64}$")),"Invalid source digest");
    check(require_safe_id(sub,"sourceRevision")==1,"Unsupported source revision");
  }
  const auto& progress=run.at("progress");
  const auto& lim=run.at("limits");
  require_exact_fields(progress,{"firstSeq","nextSeq","truncated","records"});
  auto first=require_safe_id(progress,"firstSeq"), end=require_safe_id(progress,"nextSeq");
  const auto& records=progress.at("records");
  check(records.is_array() && records.size()<=lim.at("progressRecords").get<std::size_t>() &&
    progress.at("truncated").is_boolean() && progress.at("truncated")==Json(first>1) && end==first+records.size(),"Invalid progress window");
  std::size_t total=0;
  for(const auto& record:records) {
    require_exact_fields(record,{"seq","message"});
    check(require_safe_id(record,"seq")==first++,"Progress sequence gap");
    string(record,"message",lim.at("progressRecordBytes"),false);
    auto size=encode_strict_json(record,bounds).size();
    check(size<=lim.at("progressRecordBytes").get<std::size_t>(),"Progress record bytes exceeded");
    total+=size;
  }
  check(total<=lim.at("progressBytes").get<std::size_t>(),"Progress aggregate bytes exceeded");
}

void validate_control_v2_request(const Json& request) {
  (void)encode_strict_json(request,bounds);
  require_exact_fields(request,{"v","kind","id","op","args"});
  const auto op=string(request,"op",32);
  if(op=="hello") {validate_control_request(request);return;}
  version(request,2);
  check(request.at("kind")=="request","Invalid request kind");
  require_safe_id(request,"id");
  if(op!="agent.start" && op!="agent.status" && op!="agent.cancel") {
    auto legacy=request;legacy["v"]=1;validate_control_request(legacy);return;
  }
  const auto& args=request.at("args");
  if(op=="agent.start") require_exact_fields(args,{"sessionId","profileId","publicTask"},{"limits"});
  else if(op=="agent.status") require_exact_fields(args,{"sessionId"},{"runId"});
  else require_exact_fields(args,{"sessionId","runId","reason"});
  handle(args,"sessionId");
  if(args.contains("runId")) handle(args,"runId");
  if(op=="agent.start") {
    check(std::regex_match(string(args,"profileId",128),std::regex("^[A-Za-z][A-Za-z0-9_.-]{0,127}$")),"Invalid profile id");
    public_task(args.at("publicTask"));
    if(args.contains("limits")) limits(args.at("limits"),false);
  } else if(op=="agent.cancel") {
    auto reason=string(args,"reason",32);
    check(reason=="normal" || reason=="user-cancel" || reason=="deadline" || reason=="client-failure" || reason=="worker-failure","Invalid cancellation reason");
  }
}

void validate_control_v2_response(const Json& response, const Json& request, const std::string& terminal_type) {
  validate_control_v2_request(request);
  (void)encode_strict_json(response,bounds);
  check(response.contains("ok") && response.at("ok").is_boolean(),"Invalid response status");
  const bool ok=response.at("ok");
  if(ok) require_exact_fields(response,{"v","kind","id","ok","result"});
  else require_exact_fields(response,{"v","kind","id","ok","error"});
  auto op=string(request,"op",32);
  version(response,op=="hello" ? 1 : 2);
  check(response.at("kind")=="response" && require_safe_id(response,"id")==require_safe_id(request,"id"),"Response correlation mismatch");
  if(!ok) {error(response.at("error"));return;}
  const auto& result=response.at("result");
  auto legacy=response;legacy["v"]=1;
  if(op=="hello") {
    auto selected=require_safe_id(result,"controlVersion");
    const auto& offered=request.at("args").at("controlVersions");
    check((selected==1 || selected==2) && std::find(offered.begin(),offered.end(),Json(selected))!=offered.end(),"Unrequested control version");
    legacy["result"]["controlVersion"]=1;
    validate_control_response_fixture(legacy,op);
    legacy_hello(response);
    for(const auto& cap:result.at("capabilities"))
      check(selected!=1 || cap.at("id").get<std::string>().rfind("hosting.",0)!=0,"V1 exposes hosting");
    for(const auto& required:request.at("args").at("requiredCapabilities")) {
      bool found=false;
      for(const auto& cap:result.at("capabilities")) if(cap.at("id")==required && cap.at("available")==true) found=true;
      check(found,"Required capability unavailable");
    }
  } else if(op=="agent.start") {
    require_exact_fields(result,{"runId"});handle(result,"runId");
  } else if(op=="agent.status" || op=="agent.cancel") {
    require_exact_fields(result,{"run"});
    if(result.at("run").is_null()) {
      check(op=="agent.status" && !request.at("args").contains("runId"),"Explicit run absent");return;
    }
    validate_hosted_run(result.at("run"));
    if(request.at("args").contains("runId")) check(result.at("run").at("runId")==request.at("args").at("runId"),"Run correlation mismatch");
    if(op=="agent.cancel") check(result.at("run").at("phase")=="finished","Cancel did not join cleanup");
  } else {
    if(op=="session.status" && result.value("phase","")=="submitted") {
      legacy["result"]["phase"]="authoring";
      check(result.at("cleanup").at("status")=="notStarted","Submitted session closing");
    }
    validate_control_response_fixture(legacy,op);
    if(op=="operation.status") {
      check(result.at("operationId")==request.at("args").at("operationId"),"Operation correlation mismatch");
      if(!terminal_type.empty()) validate_control_operation_fixture(result,terminal_type);
    }
  }
}

void validate_control_v2_event(const Json& event, const std::string& terminal_type) {
  (void)encode_strict_json(event,bounds);
  require_exact_fields(event,{"v","kind","seq","sessionId","event","data"});
  version(event,2);
  check(event.at("kind")=="event","Invalid event kind");
  require_safe_id(event,"seq");handle(event,"sessionId");
  auto name=string(event,"event",32);
  if(name=="agent.updated" || name=="agent.finished") {
    require_exact_fields(event.at("data"),{"run"});
    const auto& run=event.at("data").at("run");validate_hosted_run(run);
    check((run.at("phase")=="finished")== (name=="agent.finished"),"Event phase mismatch");
  } else {
    auto legacy=event;legacy["v"]=1;validate_control_event_fixture(legacy);
    if(name=="operation.finished" && !terminal_type.empty()) validate_control_operation_fixture(event.at("data"),terminal_type);
  }
}
} // namespace mirrorgate
