// ssh runs this with the prompt as its only argument and reads the answer from stdout.
import {STATE,keychain} from './platform.mjs';
import {VARIABLE,answerPrompt} from './ssh.mjs';

const result=await answerPrompt({prompt:process.argv[2]||'',id:process.env[VARIABLE]||'',style:process.env.SSH_ASKPASS_PROMPT||'',directory:STATE,secrets:keychain});
if(result.output)process.stdout.write(result.output,()=>process.exit(result.code));
else process.exit(result.code);
