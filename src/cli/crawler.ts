import { Command } from "commander";

const program = new Command();

program
  .name("crawler")
  .description("Crawl Google Drive content and sync metadata into the local index (stub).")
  .option("-m, --mode <mode>", "crawl mode: auto | full | diff", "auto")
  .option("-l, --limit <number>", "limit number of files processed in one run", (value) =>
    Number.parseInt(value, 10),
  )
  .option("--dry-run", "run without writing to external services")
  .action((options) => {
    const limitText = Number.isFinite(options.limit) ? ` with limit ${options.limit}` : "";

    console.log(
      `crawler stub running in ${options.mode} mode${limitText}${options.dryRun ? " (dry-run)" : ""}`,
    );
  });

program.parse();
