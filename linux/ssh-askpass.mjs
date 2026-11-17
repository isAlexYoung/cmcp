import {STATE, keychain} from './platform.mjs';
import {answerPrompt} from './ssh.mjs';
const result = await answerPrompt({prompt: process.argv[2] || '', id: process.env.CMCP_SSH_ASKPASS || '', style: process.env.SSH_ASKPASS_PROMPT || '', directory: STATE, secrets: keychain});
process.stdout.write(result.output, () => process.exit(result.code));
