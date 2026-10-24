import Ajv2020 from 'ajv/dist/2020.js';
const ajv = new Ajv2020({ allErrors: false, strict: false });
export const str = {type:'string',minLength:1,maxLength:32768};
export const integer = (min,max) => ({type:'integer',minimum:min,maximum:max});
export const define = (name,description,properties={},required=[],readOnly=false) => ({name,description,
  inputSchema:{type:'object',properties,required,additionalProperties:false},
  annotations:{readOnlyHint:readOnly,destructiveHint:!readOnly,openWorldHint:true}});
export function validator(definitions) {
  const checks = new Map(definitions.map(d=>[d.name,ajv.compile(d.inputSchema)]));
  return (name,args) => {
    const check = checks.get(name);
    if (!check) throw new Error('Unknown tool');
    if (!check(args)) throw new Error('Invalid arguments: ' + ajv.errorsText(check.errors));
  };
}
export const result = value => ({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
