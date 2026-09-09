import {readFileSync} from 'node:fs';
import * as codec from '../service/protocol.mjs';
const load=(name:string)=>readFileSync(new URL(`../service/${name}`,import.meta.url),'utf8');
const vectors=load('vectors.jsonl').trim().split('\n').map(line=>JSON.parse(line));
test.each(vectors.map(v=>[v.name,v]))('service wire fixture %s',(_name,vector)=>{
  const v=vector as any;
  const validate=()=>{
    if(v.kind==='raw')return codec.parse(Buffer.from(v.value),codec.LIMITS.requestBytes);
    if(v.kind==='response')return codec.response(v.value,v.request);
    return (codec as any)[v.kind](v.value);
  };
  if(v.valid)expect(validate).not.toThrow();else expect(validate).toThrow();
});
test('service schema closes every object and normative limits match codec',()=>{
  const schema=JSON.parse(load('schema.json')),contract=JSON.parse(load('contract.json'));
  expect(contract.limits).toEqual(codec.LIMITS);
  const visit=(value:any)=>{if(value&&typeof value==='object'){
    if(value.type==='object')expect(value.additionalProperties).toBe(false);
    for(const child of Object.values(value))visit(child);
  }};visit(schema);
});
