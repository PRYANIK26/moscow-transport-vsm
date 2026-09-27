import type {FastifyInstance} from 'fastify';
import {readFile, readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {extname} from 'node:path';
const directory = fileURLToPath(new URL('../../docs/', import.meta.url));
const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.md':'text/plain; charset=utf-8','.csv':'text/csv; charset=utf-8','.txt':'text/plain; charset=utf-8','.mmd':'text/plain; charset=utf-8'};
export async function registerDocs(app:FastifyInstance) {
  const files=new Map<string,{bytes:Buffer;type:string}>();
  async function collect(relative='') {
    for(const entry of await readdir(directory+relative,{withFileTypes:true})) {
      const name=relative+entry.name;
      if(entry.isDirectory()) await collect(name+'/');
      else if(entry.isFile() && mime[extname(name)]) files.set(name,{bytes:await readFile(directory+name),type:mime[extname(name)]});
    }
  }
  await collect();
  app.get('/api/docs',async(_req,reply)=>reply.redirect('/api/docs/'));
  app.get('/api/docs/',async(_req,reply)=>{const f=files.get('swagger/index.html')!;return reply.type(f.type).header('X-Content-Type-Options','nosniff').send(f.bytes);});
  app.get('/api/docs/*',async(req,reply)=>{
    const wildcard=(req.params as {'*':string})['*'];
    const name=wildcard.startsWith('overview/')?wildcard.slice('overview/'.length):wildcard;
    const f=files.get(name);
    if(!f)return reply.code(404).send({error:{code:'NOT_FOUND',message:'Документ не найден'}});
    return reply.type(f.type).header('X-Content-Type-Options','nosniff').send(f.bytes);
  });
}
