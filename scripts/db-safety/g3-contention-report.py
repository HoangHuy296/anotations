"""Offline analyzer for captured G3 contention logs. No database access."""
import json,math,statistics,sys
from pathlib import Path
run=Path(sys.argv[1]);dest=run/'contention-analysis';dest.mkdir(exist_ok=True)
def records(path,prefix):
 out=[]
 for line in path.read_text().splitlines():
  marker='# '+prefix+' '
  if line.startswith(marker):
   try:out.append(json.loads(line[len(marker):]))
   except json.JSONDecodeError:pass
 return out
def nearest(a,p):return sorted(a)[max(0,math.ceil(len(a)*p)-1)]
allprofiles={};full={}
for profile in ['baseline','candidate']:
 path=run/f'{profile}-benchmark.log';batches=records(path,'G3_BENCH_BATCH');rows=[r for batch in batches for r in batch['transactions']];summaries=records(path,'G3_BENCH_RUN');env=records(path,'G3_BENCH_ENV');held=records(path,'G3_HELD_PARENT');func_before=records(path,'G3_FUNCTIONS_BEFORE');func_after=records(path,'G3_FUNCTIONS_AFTER');locks=[]
 text=path.read_text();prefix='# G3_BENCH_LOCK_BATCH ';buffer=None
 for line in text.splitlines():
  if line.startswith(prefix):buffer=line[len(prefix):]
  elif buffer is not None and line.startswith('# '):buffer+=line[2:]
  else:continue
  try:locks.append(json.loads(buffer));buffer=None
  except json.JSONDecodeError:pass
 assert buffer is None
 assert len(rows)==7*4*5*64,(profile,len(rows));assert len(summaries)==7*4*5,(profile,len(summaries))
 raw=[]
 for workload in sorted({r['workload'] for r in rows}):
  for concurrency in [1,2,4,8]:
   group=[r for r in rows if r['workload']==workload and r['concurrency']==concurrency];runs=[r for r in summaries if r['workload']==workload and r['concurrency']==concurrency]
   lat=[r['latencyMs'] for r in group];attempts={n:{'successfulTransactions':0,'exhaustedTransactions':0,'conflictCount':0,'conflictCauses':{}} for n in [1,2,3]}
   causes={}
   for r in group:
    if r['outcome']=='committed':attempts[len(r['attempts'])]['successfulTransactions']+=1
    elif r['outcome']=='retry-exhausted':attempts[3]['exhaustedTransactions']+=1
    for ix,a in enumerate(r['attempts'],1):
     cause=a.get('prismaCode')
     if cause:
      causes[cause]=causes.get(cause,0)+1;attempts[ix]['conflictCount']+=1;attempts[ix]['conflictCauses'][cause]=attempts[ix]['conflictCauses'].get(cause,0)+1
   raw.append({'workload':workload,'concurrency':concurrency,'transactions':len(group),'p50Ms':nearest(lat,.5),'p95Ms':nearest(lat,.95),'p99Ms':nearest(lat,.99),'latencyRangeMs':[min(lat),max(lat)],'successfulThroughputMedian':statistics.median(r['successfulThroughput'] for r in runs),'successfulThroughputRange':[min(r['successfulThroughput'] for r in runs),max(r['successfulThroughput'] for r in runs)],'attempts':attempts,'totalConflictsByPrismaCode':causes,'deadlockDelta':sum(r['postgresDeadlockDelta'] for r in runs),'sampledLockWaits':sum(r['lockSamples'] for r in runs),'lockPolls':sum(r['polls'] for r in runs),'perRepetition':[{'rep':r['repetition'],'p50Ms':r['p50'],'p95Ms':r['p95'],'p99Ms':r['p99'],'successfulThroughput':r['successfulThroughput'],'conflicts':r['conflicts'],'retries':r['retries'],'exhausted':r['exhausted'],'lockWaitSamples':r['lockSamples'],'pgDeadlocks':r['postgresDeadlockDelta']} for r in runs]})
 (dest/f'{profile}-raw-transactions.json').write_text(json.dumps(rows,indent=2)+'\n')
 (dest/f'{profile}-summary.json').write_text(json.dumps(raw,indent=2)+'\n')
 allprofiles[profile]=raw
 full[profile]={'environment':env,'heldParent':held,'functionTimingBefore':func_before,'functionTimingAfter':func_after,'lockSnapshots':[r for batch in locks for r in batch['samples']]}
(dest/'raw-diagnostics.json').write_text(json.dumps(full,indent=2)+'\n')
comparisons=[]
for b,c in zip(allprofiles['baseline'],allprofiles['candidate']):
 assert (b['workload'],b['concurrency'])==(c['workload'],c['concurrency'])
 comparisons.append({'workload':b['workload'],'concurrency':b['concurrency'],'baseline':b,'candidate':c,'candidateToBaselineP95':c['p95Ms']/b['p95Ms'],'candidateToBaselineP99':c['p99Ms']/b['p99Ms'],'candidateToBaselineSuccessfulThroughput':c['successfulThroughputMedian']/b['successfulThroughputMedian'] if b['successfulThroughputMedian'] else None})
result={'profiles':allprofiles,'comparisons':comparisons,'limits':{'repetitions':5,'transactionsPerWorkloadConcurrency':320,'percentile':'nearest rank pooled','fixedOrder':'baseline then candidate','lockPollIntervalMs':20,'hostLoadControlled':False,'approvedPerformanceThresholds':None}}
(dest/'comparison.json').write_text(json.dumps(result,indent=2)+'\n')
for r in comparisons:
 if r['concurrency'] in [1,2,4,8] and r['workload'] in ['metadata-same-parent','metadata-cross-parent','bulk-insert','content-same-parent','serializable-same-parent','serializable-cross-parent','serializable-update-only']:
  def small(x):return {'p50/p95/p99':round(x['p50Ms'],2), 'p95':round(x['p95Ms'],2),'p99':round(x['p99Ms'],2),'success/s':round(x['successfulThroughputMedian'],1),'attempt success':{k:v['successfulTransactions'] for k,v in x['attempts'].items()},'exhausted':x['attempts'][3]['exhaustedTransactions'],'causes':x['totalConflictsByPrismaCode'],'locks':x['sampledLockWaits'],'deadlocks':x['deadlockDelta']}
  print(r['workload'],r['concurrency'],'base',json.dumps(small(r['baseline'])),'candidate',json.dumps(small(r['candidate'])))
