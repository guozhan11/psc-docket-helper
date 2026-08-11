import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

interface EvaluationQuestion {
  id: string;
  category: string;
  question: string;
  expectedCaseNumbers?: string[];
  mustLinkOfficial: boolean;
  reviewerFocus: string;
}

const questions = JSON.parse(
  await readFile(new URL('../evaluation/questions.json', import.meta.url), 'utf8')
) as EvaluationQuestion[];

assert.ok(Array.isArray(questions) && questions.length >= 30, 'Evaluation set must contain at least 30 questions');
assert.equal(new Set(questions.map(item => item.id)).size, questions.length, 'Evaluation IDs must be unique');
assert.ok(new Set(questions.map(item => item.category)).size >= 5, 'Evaluation set must cover at least five categories');
for (const item of questions) {
  assert.ok(item.id && item.category && item.question && item.reviewerFocus, `Invalid evaluation item: ${item.id}`);
  assert.equal(item.mustLinkOfficial, true, `${item.id} must require an official source link`);
  if (item.expectedCaseNumbers) {
    assert.ok(item.expectedCaseNumbers.every(value => /^[A-Z][A-Z0-9-]{2,30}$/.test(value)), `${item.id} has an invalid case number`);
  }
}

console.log(`Validated ${questions.length} release-evaluation questions across ${new Set(questions.map(item => item.category)).size} categories.`);
