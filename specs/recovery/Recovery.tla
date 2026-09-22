--------------------------- MODULE Recovery ---------------------------
EXTENDS FiniteSets, Naturals, TLC

\* Bounded safety model for one operator-selected MirrorGate state root.
\* Controller names are incarnation identities, never reusable process IDs.
CONSTANTS
  \* @type: Bool;
  WeakExclusive,
  \* @type: Bool;
  WeakCrossSession,
  \* @type: Bool;
  WeakEvidence

Controllers == {"controller-a", "controller-b"}
Sessions == {"session-a", "session-b"}
Runs == {"run-a"}
Resources == {"resource-a"}
Identities == {"identity-a", "identity-b"}
OwnerRoles == {"inactive", "controller", "recoverer"}
ResourceKinds == {"filesystem", "process", "cgroup", "retained_source"}
WorkStages == {"preparation", "snapshot_freeze", "build", "authorization",
                "worker_launch", "replay", "cleanup"}
ResourcePhases == {"unclaimed", "allocation_intent", "durable_owned", "active",
                   "cleanup_intent", "reclaimed", "retained_by_policy",
                   "ambiguous", "cleanup_failed"}
CleanupObservations == {"unconfirmed", "recovered", "failed", "ambiguous"}
BehaviorObservations == {"not_run", "incomplete", "passed", "failed",
                         "inconclusive"}

VARIABLE
  \* @type: Set(Str);
  leaseOwners,
  \* @type: Str -> Str;
  ownerRole,
  \* @type: Set(Str);
  crashedIncarnations,
  \* @type: Str -> Str;
  resourceKind,
  \* @type: Str -> Str;
  resourceSession,
  \* @type: Str -> Str;
  resourceController,
  \* @type: Str -> Str;
  resourcePhase,
  \* @type: Str -> Str;
  interruptionStage,
  \* @type: Str -> Str;
  recordedIdentity,
  \* @type: Str -> Str;
  currentIdentity,
  \* @type: Str -> Bool;
  rootAndPathPinned,
  \* @type: Str -> Bool;
  bootMatches,
  \* @type: Str -> Bool;
  nonPidProcessProof,
  \* @type: Str -> Bool;
  delegatedCgroup,
  \* @type: Str -> Bool;
  exactCgroup,
  \* @type: Str -> Bool;
  identityValidated,
  \* @type: Str -> Bool;
  retainedRecoverable,
  \* @type: Set(Str);
  actedResources,
  \* @type: Str -> Str;
  actionSession,
  \* @type: Set(Str);
  everReclaimed,
  \* @type: Str -> Set(Str);
  cleanupEvidence,
  \* @type: Str -> Set(Str);
  priorCleanupEvidence,
  \* @type: Str -> Set(Str);
  behaviorEvidence,
  \* @type: Str -> Set(Str);
  priorBehaviorEvidence,
  \* @type: Str -> Bool;
  evaluationComplete,
  \* @type: Str -> Str;
  evaluationOwner,
  \* @type: Set(Str);
  abandonedRuns,
  \* @type: Str;
  lastAction

vars == <<leaseOwners, ownerRole, crashedIncarnations, resourceKind,
          resourceSession, resourceController, resourcePhase, interruptionStage,
          recordedIdentity, currentIdentity, rootAndPathPinned, bootMatches,
          nonPidProcessProof, delegatedCgroup, exactCgroup, identityValidated,
          retainedRecoverable, actedResources, actionSession, everReclaimed,
          cleanupEvidence, priorCleanupEvidence, behaviorEvidence,
          priorBehaviorEvidence, evaluationComplete, evaluationOwner,
          abandonedRuns, lastAction>>

ControllerHeld ==
  Cardinality(leaseOwners) = 1 /\
  \A c \in leaseOwners: ownerRole[c] = "controller"

RecovererHeld ==
  Cardinality(leaseOwners) = 1 /\
  \A c \in leaseOwners: ownerRole[c] = "recoverer"

OwnsResource(resource) ==
  RecovererHeld \/
  (ControllerHeld /\ \E c \in leaseOwners: resourceController[resource] = c)

ResourceProof(resource) ==
  /\ recordedIdentity[resource] = currentIdentity[resource]
  /\ CASE resourceKind[resource] = "filesystem" -> rootAndPathPinned[resource]
       [] resourceKind[resource] = "process" ->
            bootMatches[resource] /\ nonPidProcessProof[resource]
       [] resourceKind[resource] = "cgroup" ->
            delegatedCgroup[resource] /\ exactCgroup[resource]
       [] resourceKind[resource] = "retained_source" ->
            rootAndPathPinned[resource] /\ retainedRecoverable[resource]

Init ==
  /\ leaseOwners = {}
  /\ ownerRole = [c \in Controllers |-> "inactive"]
  /\ crashedIncarnations = {}
  /\ resourceKind \in [Resources -> ResourceKinds]
  /\ resourceSession = [r \in Resources |-> "session-a"]
  /\ resourceController = [r \in Resources |-> "controller-a"]
  /\ resourcePhase = [r \in Resources |-> "unclaimed"]
  /\ interruptionStage = [r \in Resources |-> "preparation"]
  /\ recordedIdentity = [r \in Resources |-> "identity-a"]
  /\ currentIdentity = [r \in Resources |-> "identity-a"]
  /\ rootAndPathPinned = [r \in Resources |-> TRUE]
  /\ bootMatches = [r \in Resources |-> TRUE]
  /\ nonPidProcessProof = [r \in Resources |-> TRUE]
  /\ delegatedCgroup = [r \in Resources |-> TRUE]
  /\ exactCgroup = [r \in Resources |-> TRUE]
  /\ identityValidated = [r \in Resources |-> FALSE]
  /\ retainedRecoverable = [r \in Resources |-> FALSE]
  /\ actedResources = {}
  /\ actionSession = [r \in Resources |-> "session-a"]
  /\ everReclaimed = {}
  /\ cleanupEvidence = [r \in Resources |-> {"unconfirmed"}]
  /\ priorCleanupEvidence = cleanupEvidence
  /\ behaviorEvidence = [run \in Runs |-> {"not_run"}]
  /\ priorBehaviorEvidence = behaviorEvidence
  /\ evaluationComplete = [run \in Runs |-> FALSE]
  /\ evaluationOwner = [run \in Runs |-> "controller-a"]
  /\ abandonedRuns = {}
  /\ lastAction = "init"

AcquireOwner(c, role) ==
  /\ c \in Controllers
  /\ role \in {"controller", "recoverer"}
  /\ c \notin leaseOwners
  /\ c \notin crashedIncarnations
  /\ (WeakExclusive \/ leaseOwners = {})
  /\ leaseOwners' = leaseOwners \cup {c}
  /\ ownerRole' = [ownerRole EXCEPT ![c] = role]
  /\ lastAction' = "acquire_owner"
  /\ UNCHANGED <<crashedIncarnations, resourceKind, resourceSession,
                  resourceController, resourcePhase, interruptionStage,
                  recordedIdentity, currentIdentity, rootAndPathPinned,
                  bootMatches, nonPidProcessProof, delegatedCgroup, exactCgroup,
                  identityValidated, retainedRecoverable, actedResources,
                  actionSession, everReclaimed, cleanupEvidence,
                  priorCleanupEvidence, behaviorEvidence, priorBehaviorEvidence,
                  evaluationComplete, evaluationOwner, abandonedRuns>>

ReleaseOwner(c) ==
  /\ c \in leaseOwners
  /\ leaseOwners' = leaseOwners \ {c}
  /\ ownerRole' = [ownerRole EXCEPT ![c] = "inactive"]
  /\ lastAction' = "release_owner"
  /\ UNCHANGED <<crashedIncarnations, resourceKind, resourceSession,
                  resourceController, resourcePhase, interruptionStage,
                  recordedIdentity, currentIdentity, rootAndPathPinned,
                  bootMatches, nonPidProcessProof, delegatedCgroup, exactCgroup,
                  identityValidated, retainedRecoverable, actedResources,
                  actionSession, everReclaimed, cleanupEvidence,
                  priorCleanupEvidence, behaviorEvidence, priorBehaviorEvidence,
                  evaluationComplete, evaluationOwner, abandonedRuns>>

Crash(c) ==
  /\ c \in leaseOwners
  /\ ownerRole[c] = "controller"
  /\ leaseOwners' = leaseOwners \ {c}
  /\ ownerRole' = [ownerRole EXCEPT ![c] = "inactive"]
  /\ crashedIncarnations' = crashedIncarnations \cup {c}
  /\ abandonedRuns' = abandonedRuns \cup
       {run \in Runs: evaluationOwner[run] = c /\
                       "incomplete" \in behaviorEvidence[run] /\
                       ~evaluationComplete[run]}
  /\ lastAction' = "crash"
  /\ UNCHANGED <<resourceKind, resourceSession, resourceController,
                  resourcePhase, interruptionStage, recordedIdentity,
                  currentIdentity, rootAndPathPinned, bootMatches,
                  nonPidProcessProof, delegatedCgroup, exactCgroup,
                  identityValidated, retainedRecoverable, actedResources,
                  actionSession, everReclaimed, cleanupEvidence,
                  priorCleanupEvidence, behaviorEvidence, priorBehaviorEvidence,
                  evaluationComplete, evaluationOwner>>

AllocationIntent(r, stage, c) ==
  /\ ControllerHeld
  /\ c \in leaseOwners
  /\ r \in Resources
  /\ stage \in WorkStages
  /\ resourcePhase[r] = "unclaimed"
  /\ resourceController' = [resourceController EXCEPT ![r] = c]
  /\ resourcePhase' = [resourcePhase EXCEPT ![r] = "allocation_intent"]
  /\ interruptionStage' = [interruptionStage EXCEPT ![r] = stage]
  /\ lastAction' = "allocation_intent"
  /\ UNCHANGED <<leaseOwners, ownerRole, crashedIncarnations, resourceKind,
                  resourceSession, recordedIdentity, currentIdentity,
                  rootAndPathPinned, bootMatches, nonPidProcessProof,
                  delegatedCgroup, exactCgroup, identityValidated,
                  retainedRecoverable, actedResources, actionSession,
                  everReclaimed, cleanupEvidence, priorCleanupEvidence,
                  behaviorEvidence, priorBehaviorEvidence, evaluationComplete,
                  evaluationOwner, abandonedRuns>>

CommitOwnership(r) ==
  /\ r \in Resources
  /\ OwnsResource(r)
  /\ resourcePhase[r] = "allocation_intent"
  /\ resourcePhase' = [resourcePhase EXCEPT ![r] =
       IF resourceKind[r] = "retained_source"
       THEN "retained_by_policy" ELSE "durable_owned"]
  /\ lastAction' = "commit_ownership"
  /\ UNCHANGED <<leaseOwners, ownerRole, crashedIncarnations, resourceKind,
                  resourceSession, resourceController, interruptionStage,
                  recordedIdentity, currentIdentity, rootAndPathPinned,
                  bootMatches, nonPidProcessProof, delegatedCgroup, exactCgroup,
                  identityValidated, retainedRecoverable, actedResources,
                  actionSession, everReclaimed, cleanupEvidence,
                  priorCleanupEvidence, behaviorEvidence, priorBehaviorEvidence,
                  evaluationComplete, evaluationOwner, abandonedRuns>>

BeginUse(r) ==
  /\ r \in Resources
  /\ OwnsResource(r)
  /\ resourcePhase[r] = "durable_owned"
  /\ resourcePhase' = [resourcePhase EXCEPT ![r] = "active"]
  /\ lastAction' = "begin_use"
  /\ UNCHANGED <<leaseOwners, ownerRole, crashedIncarnations, resourceKind,
                  resourceSession, resourceController, interruptionStage,
                  recordedIdentity, currentIdentity, rootAndPathPinned,
                  bootMatches, nonPidProcessProof, delegatedCgroup, exactCgroup,
                  identityValidated, retainedRecoverable, actedResources,
                  actionSession, everReclaimed, cleanupEvidence,
                  priorCleanupEvidence, behaviorEvidence, priorBehaviorEvidence,
                  evaluationComplete, evaluationOwner, abandonedRuns>>

AuthorizeRetainedRecovery(r) ==
  /\ RecovererHeld
  /\ r \in Resources
  /\ resourcePhase[r] = "retained_by_policy"
  /\ retainedRecoverable' = [retainedRecoverable EXCEPT ![r] = TRUE]
  /\ lastAction' = "authorize_retained_recovery"
  /\ UNCHANGED <<leaseOwners, ownerRole, crashedIncarnations, resourceKind,
                  resourceSession, resourceController, resourcePhase,
                  interruptionStage, recordedIdentity, currentIdentity,
                  rootAndPathPinned, bootMatches, nonPidProcessProof,
                  delegatedCgroup, exactCgroup, identityValidated,
                  actedResources, actionSession, everReclaimed, cleanupEvidence,
                  priorCleanupEvidence, behaviorEvidence, priorBehaviorEvidence,
                  evaluationComplete, evaluationOwner, abandonedRuns>>

StartCleanup(r) ==
  /\ r \in Resources
  /\ OwnsResource(r)
  /\ resourceKind[r] # "retained_source"
  /\ resourcePhase[r] \in {"allocation_intent", "durable_owned", "active",
                              "cleanup_failed"}
  /\ resourcePhase' = [resourcePhase EXCEPT ![r] = "cleanup_intent"]
  /\ interruptionStage' = [interruptionStage EXCEPT ![r] = "cleanup"]
  /\ identityValidated' = [identityValidated EXCEPT ![r] = FALSE]
  /\ lastAction' = "start_cleanup"
  /\ UNCHANGED <<leaseOwners, ownerRole, crashedIncarnations, resourceKind,
                  resourceSession, resourceController, recordedIdentity,
                  currentIdentity, rootAndPathPinned, bootMatches,
                  nonPidProcessProof, delegatedCgroup, exactCgroup,
                  retainedRecoverable, actedResources, actionSession,
                  everReclaimed, cleanupEvidence, priorCleanupEvidence,
                  behaviorEvidence, priorBehaviorEvidence, evaluationComplete,
                  evaluationOwner, abandonedRuns>>

StartRetainedCleanup(r) ==
  /\ RecovererHeld
  /\ r \in Resources
  /\ resourcePhase[r] = "retained_by_policy"
  /\ retainedRecoverable[r]
  /\ resourcePhase' = [resourcePhase EXCEPT ![r] = "cleanup_intent"]
  /\ interruptionStage' = [interruptionStage EXCEPT ![r] = "cleanup"]
  /\ identityValidated' = [identityValidated EXCEPT ![r] = FALSE]
  /\ lastAction' = "start_retained_cleanup"
  /\ UNCHANGED <<leaseOwners, ownerRole, crashedIncarnations, resourceKind,
                  resourceSession, resourceController, recordedIdentity,
                  currentIdentity, rootAndPathPinned, bootMatches,
                  nonPidProcessProof, delegatedCgroup, exactCgroup,
                  retainedRecoverable, actedResources, actionSession,
                  everReclaimed, cleanupEvidence, priorCleanupEvidence,
                  behaviorEvidence, priorBehaviorEvidence, evaluationComplete,
                  evaluationOwner, abandonedRuns>>

ValidateIdentity(r) ==
  /\ r \in Resources
  /\ OwnsResource(r)
  /\ resourcePhase[r] = "cleanup_intent"
  /\ ResourceProof(r)
  /\ identityValidated' = [identityValidated EXCEPT ![r] = TRUE]
  /\ lastAction' = "validate_identity"
  /\ UNCHANGED <<leaseOwners, ownerRole, crashedIncarnations, resourceKind,
                  resourceSession, resourceController, resourcePhase,
                  interruptionStage, recordedIdentity, currentIdentity,
                  rootAndPathPinned, bootMatches, nonPidProcessProof,
                  delegatedCgroup, exactCgroup, retainedRecoverable,
                  actedResources, actionSession, everReclaimed, cleanupEvidence,
                  priorCleanupEvidence, behaviorEvidence, priorBehaviorEvidence,
                  evaluationComplete, evaluationOwner, abandonedRuns>>

ReplaceIdentity(r, replacement) ==
  /\ r \in Resources
  /\ replacement \in Identities
  /\ resourcePhase[r] \notin {"unclaimed", "reclaimed", "ambiguous"}
  /\ replacement # currentIdentity[r]
  /\ currentIdentity' = [currentIdentity EXCEPT ![r] = replacement]
  /\ lastAction' = "replace_identity"
  /\ UNCHANGED <<leaseOwners, ownerRole, crashedIncarnations, resourceKind,
                  resourceSession, resourceController, resourcePhase,
                  interruptionStage, recordedIdentity, rootAndPathPinned,
                  bootMatches, nonPidProcessProof, delegatedCgroup, exactCgroup,
                  identityValidated, retainedRecoverable, actedResources,
                  actionSession, everReclaimed, cleanupEvidence,
                  priorCleanupEvidence, behaviorEvidence, priorBehaviorEvidence,
                  evaluationComplete, evaluationOwner, abandonedRuns>>

ChangeBoot(r) ==
  /\ r \in Resources
  /\ resourceKind[r] = "process"
  /\ resourcePhase[r] \notin {"unclaimed", "reclaimed", "ambiguous"}
  /\ bootMatches[r]
  /\ bootMatches' = [bootMatches EXCEPT ![r] = FALSE]
  /\ lastAction' = "change_boot"
  /\ UNCHANGED <<leaseOwners, ownerRole, crashedIncarnations, resourceKind,
                  resourceSession, resourceController, resourcePhase,
                  interruptionStage, recordedIdentity, currentIdentity,
                  rootAndPathPinned, nonPidProcessProof, delegatedCgroup,
                  exactCgroup, identityValidated, retainedRecoverable,
                  actedResources, actionSession, everReclaimed, cleanupEvidence,
                  priorCleanupEvidence, behaviorEvidence, priorBehaviorEvidence,
                  evaluationComplete, evaluationOwner, abandonedRuns>>

MarkAmbiguous(r) ==
  /\ r \in Resources
  /\ OwnsResource(r)
  /\ resourcePhase[r] = "cleanup_intent"
  /\ ~ResourceProof(r)
  /\ resourcePhase' = [resourcePhase EXCEPT ![r] = "ambiguous"]
  /\ priorCleanupEvidence' = cleanupEvidence
  /\ cleanupEvidence' = [cleanupEvidence EXCEPT ![r] = @ \cup {"ambiguous"}]
  /\ lastAction' = "mark_ambiguous"
  /\ UNCHANGED <<leaseOwners, ownerRole, crashedIncarnations, resourceKind,
                  resourceSession, resourceController, interruptionStage,
                  recordedIdentity, currentIdentity, rootAndPathPinned,
                  bootMatches, nonPidProcessProof, delegatedCgroup, exactCgroup,
                  identityValidated, retainedRecoverable, actedResources,
                  actionSession, everReclaimed, behaviorEvidence,
                  priorBehaviorEvidence, evaluationComplete, evaluationOwner,
                  abandonedRuns>>

Reclaim(r, session) ==
  /\ r \in Resources
  /\ session \in Sessions
  /\ OwnsResource(r)
  /\ resourcePhase[r] = "cleanup_intent"
  /\ identityValidated[r]
  /\ ResourceProof(r)
  /\ (WeakCrossSession \/ session = resourceSession[r])
  /\ resourcePhase' = [resourcePhase EXCEPT ![r] = "reclaimed"]
  /\ actedResources' = actedResources \cup {r}
  /\ actionSession' = [actionSession EXCEPT ![r] = session]
  /\ everReclaimed' = everReclaimed \cup {r}
  /\ priorCleanupEvidence' = cleanupEvidence
  /\ cleanupEvidence' = [cleanupEvidence EXCEPT ![r] = @ \cup {"recovered"}]
  /\ lastAction' = "reclaim"
  /\ UNCHANGED <<leaseOwners, ownerRole, crashedIncarnations, resourceKind,
                  resourceSession, resourceController, interruptionStage,
                  recordedIdentity, currentIdentity, rootAndPathPinned,
                  bootMatches, nonPidProcessProof, delegatedCgroup, exactCgroup,
                  identityValidated, retainedRecoverable, behaviorEvidence,
                  priorBehaviorEvidence, evaluationComplete, evaluationOwner,
                  abandonedRuns>>

CleanupFailed(r) ==
  /\ r \in Resources
  /\ OwnsResource(r)
  /\ resourcePhase[r] = "cleanup_intent"
  /\ identityValidated[r]
  /\ ResourceProof(r)
  /\ resourcePhase' = [resourcePhase EXCEPT ![r] = "cleanup_failed"]
  /\ priorCleanupEvidence' = cleanupEvidence
  /\ cleanupEvidence' = [cleanupEvidence EXCEPT ![r] = @ \cup {"failed"}]
  /\ lastAction' = "cleanup_failed"
  /\ UNCHANGED <<leaseOwners, ownerRole, crashedIncarnations, resourceKind,
                  resourceSession, resourceController, interruptionStage,
                  recordedIdentity, currentIdentity, rootAndPathPinned,
                  bootMatches, nonPidProcessProof, delegatedCgroup, exactCgroup,
                  identityValidated, retainedRecoverable, actedResources,
                  actionSession, everReclaimed, behaviorEvidence,
                  priorBehaviorEvidence, evaluationComplete, evaluationOwner,
                  abandonedRuns>>

StartRun(run, c) ==
  /\ ControllerHeld
  /\ c \in leaseOwners
  /\ run \in Runs
  /\ "incomplete" \notin behaviorEvidence[run]
  /\ behaviorEvidence' = [behaviorEvidence EXCEPT ![run] = @ \cup {"incomplete"}]
  /\ priorBehaviorEvidence' = behaviorEvidence
  /\ evaluationOwner' = [evaluationOwner EXCEPT ![run] = c]
  /\ lastAction' = "start_run"
  /\ UNCHANGED <<leaseOwners, ownerRole, crashedIncarnations, resourceKind,
                  resourceSession, resourceController, resourcePhase,
                  interruptionStage, recordedIdentity, currentIdentity,
                  rootAndPathPinned, bootMatches, nonPidProcessProof,
                  delegatedCgroup, exactCgroup, identityValidated,
                  retainedRecoverable, actedResources, actionSession,
                  everReclaimed, cleanupEvidence, priorCleanupEvidence,
                  evaluationComplete, abandonedRuns>>

FinishRun(run, outcome, c) ==
  /\ ControllerHeld
  /\ c \in leaseOwners
  /\ run \in Runs
  /\ outcome \in {"passed", "failed", "inconclusive"}
  /\ evaluationOwner[run] = c
  /\ c \notin crashedIncarnations
  /\ run \notin abandonedRuns
  /\ "incomplete" \in behaviorEvidence[run]
  /\ ~evaluationComplete[run]
  /\ behaviorEvidence' = [behaviorEvidence EXCEPT ![run] = @ \cup {outcome}]
  /\ priorBehaviorEvidence' = behaviorEvidence
  /\ evaluationComplete' = [evaluationComplete EXCEPT ![run] = TRUE]
  /\ lastAction' = "finish_run"
  /\ UNCHANGED <<leaseOwners, ownerRole, crashedIncarnations, resourceKind,
                  resourceSession, resourceController, resourcePhase,
                  interruptionStage, recordedIdentity, currentIdentity,
                  rootAndPathPinned, bootMatches, nonPidProcessProof,
                  delegatedCgroup, exactCgroup, identityValidated,
                  retainedRecoverable, actedResources, actionSession,
                  everReclaimed, cleanupEvidence, priorCleanupEvidence,
                  evaluationOwner, abandonedRuns>>

\* Deliberate mutant: the invariant compares the actual old map with this
\* replacement, rather than trusting a special failure flag.
OverwriteEvidence(r) ==
  /\ WeakEvidence
  /\ r \in Resources
  /\ (ControllerHeld \/ RecovererHeld)
  /\ priorCleanupEvidence' = cleanupEvidence
  /\ cleanupEvidence' = [cleanupEvidence EXCEPT ![r] = {"recovered"}]
  /\ lastAction' = "overwrite_evidence"
  /\ UNCHANGED <<leaseOwners, ownerRole, crashedIncarnations, resourceKind,
                  resourceSession, resourceController, resourcePhase,
                  interruptionStage, recordedIdentity, currentIdentity,
                  rootAndPathPinned, bootMatches, nonPidProcessProof,
                  delegatedCgroup, exactCgroup, identityValidated,
                  retainedRecoverable, actedResources, actionSession,
                  everReclaimed, behaviorEvidence, priorBehaviorEvidence,
                  evaluationComplete, evaluationOwner, abandonedRuns>>

Next ==
  \/ \E c \in Controllers, role \in {"controller", "recoverer"}: AcquireOwner(c, role)
  \/ \E c \in Controllers: ReleaseOwner(c)
  \/ \E c \in Controllers: Crash(c)
  \/ \E r \in Resources, s \in WorkStages, c \in Controllers: AllocationIntent(r, s, c)
  \/ \E r \in Resources: CommitOwnership(r)
  \/ \E r \in Resources: BeginUse(r)
  \/ \E r \in Resources: AuthorizeRetainedRecovery(r)
  \/ \E r \in Resources: StartCleanup(r)
  \/ \E r \in Resources: StartRetainedCleanup(r)
  \/ \E r \in Resources: ValidateIdentity(r)
  \/ \E r \in Resources, i \in Identities: ReplaceIdentity(r, i)
  \/ \E r \in Resources: ChangeBoot(r)
  \/ \E r \in Resources: MarkAmbiguous(r)
  \/ \E r \in Resources, s \in Sessions: Reclaim(r, s)
  \/ \E r \in Resources: CleanupFailed(r)
  \/ \E run \in Runs, c \in Controllers: StartRun(run, c)
  \/ \E run \in Runs, result \in {"passed", "failed", "inconclusive"}, c \in Controllers:
       FinishRun(run, result, c)
  \/ \E r \in Resources: OverwriteEvidence(r)

TypeOK ==
  /\ leaseOwners \subseteq Controllers
  /\ ownerRole \in [Controllers -> OwnerRoles]
  /\ crashedIncarnations \subseteq Controllers
  /\ resourceKind \in [Resources -> ResourceKinds]
  /\ resourceSession \in [Resources -> Sessions]
  /\ resourceController \in [Resources -> Controllers]
  /\ resourcePhase \in [Resources -> ResourcePhases]
  /\ interruptionStage \in [Resources -> WorkStages]
  /\ recordedIdentity \in [Resources -> Identities]
  /\ currentIdentity \in [Resources -> Identities]
  /\ rootAndPathPinned \in [Resources -> BOOLEAN]
  /\ bootMatches \in [Resources -> BOOLEAN]
  /\ nonPidProcessProof \in [Resources -> BOOLEAN]
  /\ delegatedCgroup \in [Resources -> BOOLEAN]
  /\ exactCgroup \in [Resources -> BOOLEAN]
  /\ identityValidated \in [Resources -> BOOLEAN]
  /\ retainedRecoverable \in [Resources -> BOOLEAN]
  /\ actedResources \subseteq Resources
  /\ actionSession \in [Resources -> Sessions]
  /\ everReclaimed \subseteq Resources
  /\ cleanupEvidence \in [Resources -> SUBSET CleanupObservations]
  /\ priorCleanupEvidence \in [Resources -> SUBSET CleanupObservations]
  /\ behaviorEvidence \in [Runs -> SUBSET BehaviorObservations]
  /\ priorBehaviorEvidence \in [Runs -> SUBSET BehaviorObservations]
  /\ evaluationComplete \in [Runs -> BOOLEAN]
  /\ evaluationOwner \in [Runs -> Controllers]
  /\ abandonedRuns \subseteq Runs

ExclusiveOwner == Cardinality(leaseOwners) <= 1

NoActionOutsideValidatedSet ==
  \* Reclaim is the only transition that extends either set.  Its guard checks
  \* the recorded/current identity and the kind-specific proof at action time.
  \* The history remains valid if that external object later disappears.
  actedResources \subseteq everReclaimed

NoCrossSessionReclamation ==
  \A r \in actedResources: actionSession[r] = resourceSession[r]

ReclaimedIsTerminal ==
  \A r \in everReclaimed: resourcePhase[r] = "reclaimed"

EvidenceMonotonic ==
  /\ \A r \in Resources: priorCleanupEvidence[r] \subseteq cleanupEvidence[r]
  /\ \A run \in Runs: priorBehaviorEvidence[run] \subseteq behaviorEvidence[run]

AbandonedRunCannotPass ==
  \A run \in abandonedRuns:
    ~evaluationComplete[run] /\ "passed" \notin behaviorEvidence[run]

PassRequiresCompletedAuthority ==
  \A run \in Runs:
    "passed" \in behaviorEvidence[run] =>
      evaluationComplete[run]

RetainedRequiresExplicitPolicy ==
  \A r \in Resources:
    resourceKind[r] = "retained_source" /\
    resourcePhase[r] \in {"cleanup_intent", "cleanup_failed", "reclaimed"} =>
      retainedRecoverable[r]

Safety ==
  /\ TypeOK
  /\ ExclusiveOwner
  /\ NoActionOutsideValidatedSet
  /\ NoCrossSessionReclamation
  /\ ReclaimedIsTerminal
  /\ EvidenceMonotonic
  /\ AbandonedRunCannotPass
  /\ PassRequiresCompletedAuthority
  /\ RetainedRequiresExplicitPolicy

\* Eventual cleanup is conditional on the five environmental assumptions named
\* in recovery-design.md; the safety machine claims no unconditional progress.
Spec == Init /\ [][Next]_vars

RecoveryView ==
  <<leaseOwners, ownerRole, crashedIncarnations, resourceKind, resourcePhase,
    currentIdentity, bootMatches, identityValidated, retainedRecoverable,
    actedResources, actionSession, everReclaimed, cleanupEvidence,
    behaviorEvidence, evaluationComplete, evaluationOwner, abandonedRuns,
    lastAction>>

=======================================================================
