# AI model in an app: reference

Provider names, model names, prices and limits change. Read the provider's official documentation for the current
values; this file only shows the shape of the work.

## The shape of one call (any provider)

```
input text  ->  check length  ->  build the prompt (template + the person's text)
            ->  one request with a maximum answer length and a timeout
            ->  check the answer (not empty, not cut off, valid format)
            ->  show it (escaped)   and   log the token counts
```

Keep the request in one function, `askModel(prompt)`. Everything else calls that function, so tests can replace it.

## Errors to handle

| What happens | Usual meaning | What to do |
|---|---|---|
| 401 or 403 | the key is wrong, expired or has no access to that model | stop; tell the user to check the key and the account; never retry |
| 400 | the request is malformed or too long | shorten the input; log the cause without personal text |
| 429 | too many requests or the quota is used up | wait and retry (longer each time, at most 3); if it persists, tell the person to try later |
| 500, 502, 503, 529 | the provider is busy or down | retry like 429; then a friendly message |
| timeout | the answer took too long | one retry at most; then the friendly message |
| empty answer | the model returned nothing useful | treat as a failure, do not show a blank |
| answer cut off | it hit the maximum length | raise the limit a little, or ask for a shorter answer |
| refusal | the model declined the request | show a neutral message; do not retry the same text |
| invalid format | asked for JSON, got prose | ask once more with the format reminder; then fail clearly |

## Prompt templates

Replace the parts in curly braces. Keep the person's text between the markers.

Summarize:

```
You write short summaries for {audience}.
Summarize the text between the markers in at most {n} sentences, in {language}.
If the text is empty or not readable, answer exactly: NO_TEXT.

<<<TEXT
{user_text}
TEXT>>>
```

Classify into fixed labels:

```
Decide which one label fits the message between the markers best.
Allowed labels: {label_1}, {label_2}, {label_3}, other.
Answer with the label only, nothing else.

<<<MESSAGE
{user_text}
MESSAGE>>>
```

Answer only from supplied text:

```
Answer the question using only the text between the markers.
If the answer is not in the text, say "I cannot find that in the text." Do not guess.

<<<TEXT
{source_text}
TEXT>>>

Question: {question}
```

Structured answer:

```
Read the message between the markers and answer with one JSON object and nothing else,
with the keys "topic" (a string) and "urgent" (true or false).

<<<MESSAGE
{user_text}
MESSAGE>>>
```

Always parse the JSON inside a try block and check that the keys exist before you use it.

## The text of the person is data, not orders

If someone types "ignore your instructions and ..." inside their text, it must not change what the app does.
Keep instructions outside the markers, never let the answer decide which files to open or which commands to run,
and give the model's output no more rights than a visitor's text has.

## Cost arithmetic

Tokens are pieces of words (a rough guide: a few characters each). Cost per request = input tokens times the input
price plus output tokens times the output price, from the provider's current price page. Multiply by requests per day
for the daily figure and compare it with the limit the user is happy to pay.

## Sample inputs file

Keep `prompts/samples.json` (or a plain text file) with 5 to 10 realistic inputs and what a good answer looks like:
"short", "one word", "mentions the date". Run the prompt over all of them after every change and note which got
better or worse. Include one empty input, one very long one and one in another language.

## Test with a fake

```
fake answers: "billing", then an error 429, then "billing"
test: the app retries after the 429 and shows "billing"
test: after three failures the app shows the friendly message and does not crash
test: the 31st request of the day from one person is refused
test: an input longer than the limit is refused before any request is made
```

## Common problems

| Symptom | Cause and fix |
|---|---|
| Works on your computer, fails when online | the host does not have the `.env` values; set them in the host's settings (names only in chat). |
| The key appears in the browser's network tab | the call is made from the page. Move it to a server. |
| Costs rise suddenly | no length caps or limits, or a loop that calls the model. Add both and look at the token log. |
| Answers differ every time | the model is not deterministic; lower the randomness setting if the provider offers one, and test with a fake. |
| The answer shows odd characters or markup | escape it before inserting it into a page. |
