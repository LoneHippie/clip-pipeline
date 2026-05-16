# Viral Clip Criteria

## What makes a clip go viral

### Strong starts (pick one per clip)
- **Bold opener** — a surprising claim or counterintuitive statement in the first 3 seconds
- **Emotional peak** — the most dramatic or moving moment in the video
- **Question hook** — a question the viewer immediately wants answered
- **Visual/sound hook** — something unexpected that grabs attention before any words

### Content patterns that perform
1. Surprising or counterintuitive facts
2. Actionable, specific advice (numbered steps, named frameworks)
3. Strong personal opinions stated with confidence
4. Emotional or vulnerable moments (authenticity beats polish)
5. Story with a clear arc: setup → tension → resolution

### Red flags — avoid these clips
- Starts mid-sentence or mid-explanation without context
- Contains unresolved questions or promises something outside the clip
- Has more than 3 seconds of dead air or filler at the start
- Uses jargon the average viewer won't recognize without setup
- Clip ends abruptly before a conclusion is reached

## Duration guidelines
- **Sweet spot**: 50–75 seconds
- **Acceptable range**: 45–90 seconds
- Under 45 s: usually too short to build context; over 90 s: loses momentum

## Timestamp format
Return start and end as `MM:SS` only. Examples: `"01:23"`, `"12:45"`.
Do NOT include sub-second precision. Do NOT return word-level timestamps here — those come from Whisper.

<!-- ## Composite clips (optional — use sparingly) -->
## Composite clips

A composite clip splices two to five short segments from different points in the video into a single continuous clip. Use this ONLY when the segments genuinely complement each other to form a narrative payoff that neither segment achieves alone.

### When to use
- Setup in one moment + punchline delivered later (comedy, debate)
- A prediction or claim made early + the outcome revealed later
- Question posed early + answer given at a different point

### Hard rules
- Return **at most one** composite clip per video
- Each segment: **10–40 seconds**
- Total composite length: **25–90 seconds** across all segments
- Segments must be non-overlapping and in chronological order
<!-- - If no strong narrative connection exists across the video, skip it entirely — do NOT force one -->
- Require at least ONE composite clip per video processed

### Do NOT use for
- Segments that happen to be on the same topic but don't form a cause-effect or setup-payoff arc
- Clips where each segment already works standalone — return them as separate singles instead
