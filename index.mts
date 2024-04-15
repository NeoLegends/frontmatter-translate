#!/usr/bin/env node

import { v2 } from "@google-cloud/translate";
import chalk from "chalk";
import enquirer from "enquirer";
import matter from "gray-matter";
import jp from "jsonpath";
import cloneDeep from "lodash/cloneDeep.js";
import orderBy from "lodash/orderBy.js";
import zip from "lodash/zip.js";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

const getInputLanguage = (path: string): string => path.split(".").at(-2)!;

const selectKeys = async (
  file: string,
  output: string | null | undefined
): Promise<string> => {
  const inputFile = await readFile(file, { encoding: "utf-8" });
  const { data } = matter(inputFile);

  const stringNodes = jp
    .nodes(data, "$..*")
    .filter(({ value }) => typeof value === "string" && value.length > 0);

  // First sort by whether the contents contain whitespace, then by whether they
  // contain a mix of lowercase and uppercase letters.
  //
  // This makes for a pretty good heuristic if a value is human text or not.
  const byPrio = orderBy(
    stringNodes,
    [
      (a) => /\s/g.test(a.value.trim()),
      (a) => a.value !== a.value.toUpperCase(),
    ],
    ["desc", "desc"]
  );

  const answers = await enquirer.prompt(
    byPrio.map(({ path, value }) => {
      const stringKey = jp.stringify(path);
      return {
        type: "confirm",
        // escape keys so that enquirer doesn't create a recursive object
        name: stringKey.replace(/\./g, ":"),
        message: `Translate ${chalk.blue(stringKey)}?:\n${chalk.yellow(
          value
        )}\n`,
      };
    })
  );
  const toTranslate = Object.entries(answers)
    .filter(([, answer]) => answer)
    .map(([key]) => key.replace(/:/g, "."))
    .join("\n");

  let outputFile = output;
  if (!outputFile) {
    const parsedPath = path.parse(file as string);
    outputFile = path.join(parsedPath.dir, `${parsedPath.base}.keys`);
  }
  await writeFile(outputFile, toTranslate, { encoding: "utf-8" });

  console.log(
    `Translatable keys written to ${path.relative(process.cwd(), outputFile)}.`
  );

  return outputFile;
};

const translate = async (
  inputMatterFile: string,
  keyFile: string,
  targetLanguages: string[]
) => {
  const translator = new v2.Translate();

  const sourceLanguage = getInputLanguage(inputMatterFile);
  const [keys, inputMatter] = await Promise.all([
    readFile(keyFile, { encoding: "utf-8" }).then((contents) =>
      contents
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line)
    ),
    readFile(inputMatterFile, { encoding: "utf-8" }).then((contents) =>
      matter(contents)
    ),
  ]);

  const toTranslate = keys.flatMap(
    (key) => jp.query(inputMatter.data, key, 1) as string[]
  );
  for (const language of targetLanguages) {
    const [[translatedKeys], [translatedBody]] = await Promise.all([
      toTranslate.length > 0
        ? translator.translate(toTranslate, {
            from: sourceLanguage,
            to: language,
          })
        : [[]],
      inputMatter.content
        ? translator.translate(inputMatter.content, {
            from: sourceLanguage,
            to: language,
          })
        : "",
    ]);

    if (keys.length !== translatedKeys.length) {
      console.log(JSON.stringify(keys));
      console.log(JSON.stringify(translatedKeys));
      throw new Error(
        `Len mismatch ${keys.length} vs. ${translatedKeys.length}`
      );
    }

    const resultObject = cloneDeep(inputMatter.data);
    for (const [key, translatedValue] of zip(keys, translatedKeys)) {
      jp.value(resultObject, key!, translatedValue);
    }

    const newMatter = matter.stringify(translatedBody, resultObject);

    const parsedPath = path.parse(inputMatterFile);
    const fileNameOnly = path.parse(parsedPath.name).name;
    const outPath = path.join(
      path.dirname(inputMatterFile),
      `${fileNameOnly}.${language}${parsedPath.ext}`
    );
    await writeFile(outPath, newMatter, { encoding: "utf-8" });

    const relativePath = path.relative(process.cwd(), outPath);
    console.log(
      `Translations from ${sourceLanguage?.toUpperCase()} to ${language?.toUpperCase()} written to ${relativePath}.`
    );
  }
};

const main = async () => {
  const args = yargs(hideBin(process.argv));
  await args
    .command(
      "$0 <content>",
      "select keys and translate a content/frontmatter file",
      (yargs) =>
        yargs
          .positional("content", {
            alias: "f",
            demandOption: true,
            description: "content/frontmatter file to load",
            type: "string",
          })
          .option("output", {
            alias: "o",
            description: "output file to write the keys to translate to",
            type: "string",
          }),
      async ({ content, output }) => {
        const keyFile = await selectKeys(content as string, output as string);

        const inputLanguage = getInputLanguage(content as string);
        const { languages } = await enquirer.prompt<{ languages: string[] }>({
          name: "languages",
          message:
            "Which languages do you want to translate to? Separate them by comma.",
          type: "list",
        });
        const filteredLanguages = new Set(
          languages
            .map((l) => l.trim().toLowerCase())
            .filter((l) => l !== inputLanguage)
        );

        await translate(content as string, keyFile, [...filteredLanguages]);
      }
    )
    .command(
      "select <content>",
      "select keys to translate for translation at a later point in time",
      (yargs) =>
        yargs
          .positional("content", {
            alias: "f",
            demandOption: true,
            description: "content/frontmatter file to load",
            type: "string",
          })
          .option("output", {
            alias: "o",
            description: "output file to write the keys to translate to",
            type: "string",
          }),
      async ({ content, output }) => {
        await selectKeys(content as string, output);
      }
    )
    .command(
      "translate <keys> <content> <languages..>",
      "select keys to translate for translation at a later point in time",
      (yargs) =>
        yargs
          .positional("keys", {
            alias: "k",
            demandOption: true,
            description:
              "key file specifying the keys in <content> to translate",
            type: "string",
          })
          .positional("content", {
            alias: "f",
            demandOption: true,
            description: "content/frontmatter file to load",
            type: "string",
          })
          .positional("languages", {
            alias: "l",
            array: true,
            demandOption: true,
            description: "languages to translate the content into",
            type: "string",
          }),
      async ({ content, keys, languages }) => {
        await translate(
          content as string,
          keys as string,
          languages as string[]
        );
      }
    )
    .help()
    .version()
    .wrap(Math.min(120, args.terminalWidth()))
    .parseAsync();
};

main();
