"""Offline aggregation only; never connects to a database."""
import json, math, sys, statistics
from pathlib import Path
run=Path(sys.argv[1]);out=run/'benchmark-analysis';out.mkdir(exist_ok=True)
def parse(profile,tag):
 text=(run/(profile+'-benchmark.log')).read_text()
 prefix='# '+tag+' '
 result=[];buffer=None
 for line in text.splitlines():
  if line.startswith(prefix):buffer=line[len(prefix):]
  elif buffer is not None and line.startswith('# '):buffer+=line[2:]
  else:continue
  try:result.append(json.loads(buffer));buffer=None
  except json.JSONDecodeError:pass # Node TAP splits long stdout records into comment chunks.
 assert buffer is None, 'incomplete TAP JSON record: '+tag
 return result
def q(xs,p):return sorted(xs)[max(0,math.ceil(len(xs)*p)-1)]
profiles={};environments={}
for p in ['baseline','candidate']:
 raw=parse(p,'G3_BENCH_RAW')[0];summary=parse(p,'G3_BENCH_SUMMARY')[0];locks=parse(p,'G3_BENCH_LOCKS')[0]
 assert len(raw)==3456 and len(summary)==54
 environments[p]=parse(p,'G3_BENCH_ENV')[0]
 for name,data in [('transactions',raw),('runs',summary),('lock-samples',locks)]:
  (out/(p+'-'+name+'.json')).write_text(json.dumps(data,indent=2)+'\n')
 groups=[]
 for workload in sorted({r['workload'] for r in raw}):
  for concurrency in [1,4,8]:
   rows=[r for r in raw if r['workload']==workload and r['concurrency']==concurrency]
   runs=[r for r in summary if r['workload']==workload and r['concurrency']==concurrency]
   lat=[r['latencyMs'] for r in rows]
   groups.append(dict(workload=workload,concurrency=concurrency,transactions=len(rows),p50=q(lat,.5),p95=q(lat,.95),p99=q(lat,.99),maxLatency=max(lat),medianThroughput=statistics.median(r['throughput'] for r in runs),throughputRange=[min(r['throughput'] for r in runs),max(r['throughput'] for r in runs)],conflicts=sum(len(r['errors']) for r in rows),retries=sum(len(r['attemptMs'])-1 for r in rows),exhausted=sum(r['outcome']=='retry-exhausted' for r in rows),deadlocks=sum(r['postgresDeadlockDelta'] for r in runs),lockWaitSamples=sum(r['lockSamples'] for r in runs),lockPolls=sum(r['polls'] for r in runs)))
 profiles[p]=groups
comparisons=[]
for b,c in zip(profiles['baseline'],profiles['candidate']):
 assert (b['workload'],b['concurrency'])==(c['workload'],c['concurrency'])
 comparisons.append(dict(workload=b['workload'],concurrency=b['concurrency'],baseline=b,candidate=c,p95Ratio=c['p95']/b['p95'],p99Ratio=c['p99']/b['p99'],throughputRatio=c['medianThroughput']/b['medianThroughput']))
result={'environments':environments,'comparisons':comparisons,'performanceAccepted':False,'limitations':['Three sequential repetitions per workload; baseline runs first, candidate second on same instance. Order and host-load bias are not eliminated.','512 assets, 8 datasets, 1/4/8 clients, 64 transactions per repetition. Not production-scale or a soak test.','Nearest-rank pooled p99 has only 192 observations per workload/concurrency. No confidence interval or significance claim.','10ms lock polling undercounts short waits; lock samples are not unique blocked transactions or wait duration.','log_statement=all is identical in both phases but adds diagnostic overhead.','Baseline retains existing visualization triggers. It is the recovered application schema, not a trigger-free database.','No latency/throughput threshold has been approved. Exhausted transactions remain failures, even if expected under stress.']}
(out/'comparison.json').write_text(json.dumps(result,indent=2)+'\n')
for r in comparisons:
 if r['concurrency']==8:
  print(r['workload'],json.dumps({p:{k:r[p][k] for k in ['p50','p95','p99','medianThroughput','conflicts','retries','exhausted','deadlocks','lockWaitSamples']} for p in ['baseline','candidate']}))
