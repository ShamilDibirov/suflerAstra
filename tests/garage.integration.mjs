import { execFileSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
const id = `sufler-garage-test-${randomUUID().slice(0,8)}`;
const volumes = [`${id}-meta`, `${id}-data`];
const env = { ...process.env, GARAGE_RPC_SECRET: randomBytes(32).toString('hex'), GARAGE_DEFAULT_ACCESS_KEY: `GK${randomBytes(16).toString('hex')}`, GARAGE_DEFAULT_SECRET_KEY: randomBytes(32).toString('hex'), GARAGE_DEFAULT_BUCKET: 'sufler', GARAGE_ALLOW_WORLD_READABLE_SECRETS: 'true' };
const docker = args => execFileSync('docker', args, { env, stdio: 'pipe' });
async function start() {
  docker(['run','-d','--name',id,'-p','127.0.0.1::3900',...Object.keys(env).filter(k=>k.startsWith('GARAGE_')).flatMap(k=>['-e',k]),'-v',`${volumes[0]}:/var/lib/garage/meta`,'-v',`${volumes[1]}:/var/lib/garage/data`,'sufler-garage:test','/garage','server','--single-node','--default-bucket']);
  const port = docker(['port',id,'3900']).toString().trim().split(':').at(-1);
  const options = { endpoint:`http://127.0.0.1:${port}`,region:'garage',forcePathStyle:true,credentials:{accessKeyId:env.GARAGE_DEFAULT_ACCESS_KEY,secretAccessKey:env.GARAGE_DEFAULT_SECRET_KEY} };
  const client = new S3Client(options);
  for(let i=0;i<60;i++) { try { await client.send(new HeadBucketCommand({Bucket:'sufler'})); return {client,options}; } catch { await new Promise(r=>setTimeout(r,1000)); } }
  throw new Error('Garage did not become ready');
}
try {
  let {client,options} = await start();
  await client.send(new PutObjectCommand({Bucket:'sufler',Key:'test/source.txt',Body:Buffer.from('Проверка источника'),ContentType:'text/plain'}));
  assert.equal(await (await client.send(new GetObjectCommand({Bucket:'sufler',Key:'test/source.txt'}))).Body.transformToString(),'Проверка источника');
  const denied = new S3Client({...options,credentials:{accessKeyId:env.GARAGE_DEFAULT_ACCESS_KEY,secretAccessKey:'invalid'}});
  await assert.rejects(denied.send(new GetObjectCommand({Bucket:'sufler',Key:'test/source.txt'}))); denied.destroy(); client.destroy();
  docker(['rm','-f',id]); ({client} = await start());
  assert.equal(await (await client.send(new GetObjectCommand({Bucket:'sufler',Key:'test/source.txt'}))).Body.transformToString(),'Проверка источника');
  await client.send(new DeleteObjectCommand({Bucket:'sufler',Key:'test/source.txt'}));
  await assert.rejects(client.send(new GetObjectCommand({Bucket:'sufler',Key:'test/source.txt'}))); client.destroy();
  console.log('Garage: upload/download, invalid credentials, persistence after recreation, deletion passed.');
} finally {
  try {docker(['rm','-f',id]);} catch {}
  for(const volume of volumes) try {docker(['volume','rm',volume]);} catch {}
}
