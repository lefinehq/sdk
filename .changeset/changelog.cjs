// @changesets/changelog-git without the commit hash: a CHANGELOG line names what changed, not a commit
// (the repo the hash pointed to may not be the one people read). Same output otherwise.
"use strict";

Object.defineProperty(exports, "__esModule", { value: true });

const getReleaseLine = async (changeset) => {
  const [firstLine, ...futureLines] = changeset.summary.split("\n").map((l) => l.trimEnd());
  let line = `- ${firstLine}`;
  if (futureLines.length > 0) line += `\n${futureLines.map((l) => `  ${l}`).join("\n")}`;
  return line;
};

const getDependencyReleaseLine = async (_changesets, dependenciesUpdated) => {
  if (dependenciesUpdated.length === 0) return "";
  return ["- Updated dependencies", ...dependenciesUpdated.map((d) => `  - ${d.name}@${d.newVersion}`)].join("\n");
};

exports.default = { getReleaseLine, getDependencyReleaseLine };
