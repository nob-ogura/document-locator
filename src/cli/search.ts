import { Command } from "commander";

const program = new Command();

program
  .name("search")
  .description("Query indexed documents and print the top matches (stub).")
  .option("-q, --query <text>", "text query to search for", "")
  .option(
    "-k, --top-k <number>",
    "number of results to return",
    (value) => Number.parseInt(value, 10),
    5,
  )
  .option("--json", "output results as JSON")
  .action((options) => {
    const payload = {
      query: options.query,
      topK: options.topK,
      format: options.json ? "json" : "text",
    };

    if (options.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(
      `search stub → query="${payload.query}" topK=${payload.topK} format=${payload.format}`,
    );
  });

program.parse();
