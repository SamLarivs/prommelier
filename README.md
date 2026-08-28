# Prommelier

A blind tasting room for your prompts.

Prompt engineering frameworks tell you what a good prompt should contain. They don't tell you whether yours got better after you applied the advice. Prommelier closes that loop the way a sommelier would: score the prompt, refine it, then pour both versions blind and let a judge pick the better glass.

## The pipeline

**Draft:** paste your prompt as you'd type it today. Optionally say what it's for, which sharpens the judge later.

**Diagnose:** the prompt gets scored 0-10 across six dimensions: task clarity, context, constraints, output format, examples, and audience & tone. You also get the 2-4 clarifying questions whose answers would most improve this specific prompt. Not every dimension needs a 10; a simple factual question doesn't need examples, and the scorer knows that.

**Refine:** your answers get folded into a rewrite. Skipped questions become explicit defaults in the prompt rather than silent ambiguity. The rewrite adds only what earns its place, since a great prompt is the shortest one that fully specifies the job.

**Prove:** the tasting. Both prompts run live against the same model, and a judge scores the two outputs on five criteria without knowing which prompt produced which. Labels are randomized on every run to kill position bias, and you can inspect the raw outputs yourself. Sometimes the original wins. That's the point of pouring blind.

## Running it

```bash
npm install
npm run dev
```

You'll need an Anthropic API key from console.anthropic.com. Paste it into the field at the top of the app. Calls go directly from your browser to the Anthropic API; the key is held in component state only and never persisted or sent anywhere else.

A full pipeline run makes five API calls (diagnose, refine, two live runs, one judgment), so expect a run to cost a few cents depending on prompt length.

## Stack

React 18 and Vite. No backend, no database, no CSS framework. The whole app is one component file, which is deliberate: it's meant to be read.

## Caveats

LLM-as-judge is a useful signal, not ground truth, and one blind pour tells you less than ten would. If you're using this to settle an argument about a production prompt, re-run the tasting a few times and look at the spread, not one verdict.

## License

MIT
