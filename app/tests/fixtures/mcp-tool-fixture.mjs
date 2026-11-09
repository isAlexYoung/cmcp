// A small third-party style stdio MCP server for the mcp-tools proxy tests. No dependencies.
import readline from 'node:readline';
import fs from 'node:fs';
const marker=process.env.FIXTURE_MARKER;if(marker)fs.appendFileSync(marker,'start '+process.pid+'\n');
const tools=[
  {name:'echo',description:'Echo the text back',inputSchema:{$schema:'http://json-schema.org/draft-07/schema#',type:'object',properties:{text:{type:'string'}},required:['text']}},
  {name:'env',description:'Return one environment variable',inputSchema:{type:'object',properties:{name:{type:'string'}},required:['name']}},
  {name:'slow',description:'Wait, then answer',inputSchema:{type:'object',properties:{ms:{type:'integer'}}}},
  {name:'crash',description:'Exit without answering',inputSchema:{type:'object',properties:{}}},
  {name:'grow',description:'Add a tool and announce it',inputSchema:{type:'object',properties:{}}},
  {name:'ask',description:'Ask the user a question (elicitation)',inputSchema:{type:'object',properties:{}}},
  {name:'a_very_long_upstream_tool_name_that_needs_truncation',description:'Long name',inputSchema:{type:'object',properties:{}}},
];
const out=m=>process.stdout.write(JSON.stringify(m)+'\n');
const pending=new Map();let next=1;
readline.createInterface({input:process.stdin}).on('line',line=>{
  let m;try{m=JSON.parse(line);}catch{return;}
  if(m.id!==undefined&&!m.method&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);return;}
  const reply=result=>out({jsonrpc:'2.0',id:m.id,result});
  if(m.method==='initialize')return reply({protocolVersion:m.params.protocolVersion,capabilities:{tools:{listChanged:true}},serverInfo:{name:'fixture',version:'1.0.0'}});
  if(m.method==='tools/list')return reply({tools});
  if(m.method==='ping')return reply({});
  if(m.method!=='tools/call'){if(m.id!==undefined)out({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'nope'}});return;}
  const {name,arguments:args={}}=m.params,text=value=>reply({content:[{type:'text',text:String(value)}]});
  if(name==='echo')return text(args.text);
  if(name==='env')return text(process.env[args.name]??'<unset>');
  if(name==='slow')return setTimeout(()=>text('slept'),args.ms||100);
  if(name==='crash')process.exit(3);
  if(name==='grow'){tools.push({name:'grown_'+tools.length,description:'Added later',inputSchema:{type:'object',properties:{}}});out({jsonrpc:'2.0',method:'notifications/tools/list_changed'});return text('grown');}
  if(name==='ask'){const id='q'+next++;pending.set(id,answer=>text(JSON.stringify(answer.error||answer.result)));out({jsonrpc:'2.0',id,method:'elicitation/create',params:{message:'Name?',requestedSchema:{type:'object',properties:{}}}});return;}
  if(name.startsWith('a_very_long'))return text('long');
  out({jsonrpc:'2.0',id:m.id,error:{code:-32602,message:'Unknown tool '+name}});
});
