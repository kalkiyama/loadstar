import { statusRollup } from '../statuscodes.mjs';
let p=0,f=0; const ok=(n,c,d)=>{c?(console.log('  \u2713 '+n),p++):(console.log('  \u2717 '+n+(d?'  -> '+JSON.stringify(d):'')),f++)};

console.log('\nCASE 1 - sums across endpoints and sorts by code');
{
  const s={total_requests:60,per_endpoint:[
    {name:'a',status_codes:{'200':30,'404':5}},
    {name:'b',status_codes:{'200':20,'500':5}}]};
  const r=statusRollup(s);
  ok('200s summed across both endpoints', r.codes.find(c=>c.code===200).count===50, r.codes);
  ok('sorted ascending', r.codes.map(c=>c.code).join()==='200,404,500', r.codes.map(c=>c.code));
  ok('classes assigned', r.codes.map(c=>c.klass).join()==='s2,s4,s5');
  ok('no phantom "no response" when all requests are accounted for', !r.codes.some(c=>c.klass==='none'));
}
console.log('\nCASE 2 - THE HONEST CASE: network failures carry no status code');
{
  const s={total_requests:100,per_endpoint:[{name:'a',status_codes:{'200':40}}]};
  const r=statusRollup(s);
  const none=r.codes.find(c=>c.klass==='none');
  ok('the 60 uncoded requests are reported explicitly', none && none.count===60, r.codes);
  ok('labelled "no response"', none.label==='no response');
  ok('coded vs total both exposed', r.coded===40 && r.total===100);
}
console.log('\nCASE 3 - redirect hops count (they are real responses)');
{
  const s={total_requests:72,per_endpoint:[
    {name:'p',status_codes:{'200':24}},
    {name:'p-0',sub_sample:true,status_codes:{'301':24}},
    {name:'p-1',sub_sample:true,status_codes:{'200':24}}]};
  const r=statusRollup(s);
  ok('the 301 hop appears', r.codes.find(c=>c.code===301).count===24);
  ok('200s from parent and hop are summed', r.codes.find(c=>c.code===200).count===48);
  ok('nothing marked missing', !r.codes.some(c=>c.klass==='none'), r.codes);
}
console.log('\nCASE 4 - the real proxy run (429 + 404, zero success)');
{
  const s={total_requests:1010,per_endpoint:[{name:'x',status_codes:{'429':895,'404':115}}]};
  const r=statusRollup(s);
  ok('both codes present and correctly classed', r.codes.length===2 && r.codes.every(c=>c.klass==='s4'));
  ok('no 2xx invented', !r.codes.some(c=>c.klass==='s2'));
}
console.log('\nCASE 5 - edges');
{
  ok('empty summary returns null', statusRollup({per_endpoint:[]})===null && statusRollup(null)===null);
  ok('junk codes ignored', statusRollup({total_requests:1,per_endpoint:[{status_codes:{'0':5,'abc':2,'200':1}}]}).codes.length===1);
  ok('missing total_requests does not fabricate a gap',
     !statusRollup({per_endpoint:[{status_codes:{'200':5}}]}).codes.some(c=>c.klass==='none'));
}
console.log('\nPASS '+p+'  FAIL '+f); process.exit(f?1:0);
