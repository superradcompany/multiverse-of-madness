import { homedir } from 'node:os';
import { resolve } from 'node:path';
// Set before loading the SDK, which caches configuration in its native binding.
process.env.MSB_HOME ??= resolve(homedir(), '.mom-runtime');
process.env.MSB_PATH ??= resolve('.runtime/bin/msb');
process.env.MSB_LIBKRUNFW_PATH ??= resolve(process.platform === 'darwin' ? '.runtime/lib/libkrunfw.5.dylib' : '.runtime/lib/libkrunfw.so.5');
