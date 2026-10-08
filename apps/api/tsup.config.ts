import { defineConfig } from 'tsup';
import { mkdir,copyFile } from 'node:fs/promises';
export default defineConfig({entry:['src/main.ts','src/cli.ts'],format:['esm'],platform:'node',target:'node24',outDir:'dist',clean:true,noExternal:[/^@sufler\/shared/],async onSuccess(){await mkdir('dist/eval',{recursive:true});await copyFile('../../eval/ru-cases.json','dist/eval/ru-cases.json');}});
