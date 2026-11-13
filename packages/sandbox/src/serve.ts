import { rmSync } from 'node:fs';
import { serveSandbox } from './server.ts';

// Entry point of the sandbox container.
const socket = process.env.SANDBOX_SOCKET ?? '/run/sandbox/sandbox.sock';
rmSync(socket, { force: true });
serveSandbox(socket, { concurrency: Number(process.env.SANDBOX_CONCURRENCY ?? 2) });
console.log(JSON.stringify({ message: 'sandbox listening', socket }));
