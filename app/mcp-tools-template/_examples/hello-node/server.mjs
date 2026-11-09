// Minimal stdio MCP server with no dependencies: one tool, "greet".
// Copy this folder to ../hello (no leading underscore) to try it; CMCP skips folders starting with _.
import readline from 'node:readline';
const tools=[{name:'greet',description:'Say hello to a name on this computer',inputSchema:{type:'object',properties:{name:{type:'string'}},required:['name']}}];
const send=message=>process.stdout.write(JSON.stringify(message)+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
  let m;try{m=JSON.parse(line);}catch{return;}
  if(m.id===undefined)return; // notifications need no answer
  if(m.method==='initialize')return send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'hello-node',version:'1.0.0'}}});
  if(m.method==='tools/list')return send({jsonrpc:'2.0',id:m.id,result:{tools}});
  if(m.method==='tools/call'&&m.params.name==='greet')return send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'Hello, '+m.params.arguments.name+'!'}]}});
  send({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Unknown method or tool'}});
});
