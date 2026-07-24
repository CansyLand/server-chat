import fs from 'node:fs';
import os from 'node:os';
import { WebSocket } from 'ws';

const token = fs.readFileSync(`${os.homedir()}/xqlytskg-chat/data/device-token.secret`, 'utf8').trim();
const ws = new WebSocket(`ws://127.0.0.1:8720/ws?token=${encodeURIComponent(token)}`);

ws.on('open', () => {
  console.log('OPEN, token len', token.length);
  ws.send(JSON.stringify({ type: 'message', text: 'Reply with exactly: WS SMOKE TEST OK' }));
});
ws.on('message', (d) => console.log('MSG', d.toString().slice(0, 300)));
ws.on('close', (c, r) => console.log('CLOSE', c, r.toString()));
ws.on('error', (e) => console.log('ERR', e.message));
setTimeout(() => process.exit(0), 20000);
