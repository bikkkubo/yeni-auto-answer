import { walk } from "https://deno.land/std@0.177.0/fs/walk.ts";

// テストファイルを探索して実行
for await (const entry of walk(".", {
  includeDirs: false,
  match: [/\.test\.ts$/],
  skip: [/node_modules/],
})) {
  console.log(`Running tests in ${entry.path}...`);
  await import(`./${entry.path}`);
} 