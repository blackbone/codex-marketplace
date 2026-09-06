#!/usr/bin/env python3
"""Render documentation previews from recorded e2e output (requires Pillow).

Capture first with SEMANTIC_SEARCH_EXAMPLE_OUTPUT=/tmp/example.json node scripts/e2e-test.mjs.
Then: python3 scripts/render-examples.py /tmp/example.json
"""
import json
import sys
import textwrap
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

record = json.loads(Path(sys.argv[1]).read_text())
output = Path(__file__).resolve().parent.parent / 'assets' / 'screenshots'


def font(size, bold=False):
    candidates = [
        '/System/Library/Fonts/Supplemental/Arial Bold.ttf' if bold else '/System/Library/Fonts/Supplemental/Arial.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' if bold else '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    raise RuntimeError('Install Arial or DejaVu Sans to render the previews')


def render(filename, title, subtitle, sections):
    im = Image.new('RGB', (1200, 1020), '#f3f5f6')
    draw = ImageDraw.Draw(im)
    draw.text((64, 44), 'DOCS / LOCAL DOCUMENTATION', font=font(18), fill='#556366')
    draw.text((64, 90), title, font=font(38, True), fill='#172123')
    draw.text((64, 148), subtitle, font=font(21), fill='#4c595e')
    y = 211
    for heading, lines in sections:
        draw.text((64, y), heading, font=font(25, True), fill='#172123')
        y += 45
        wrapped = [part for block in lines for line in block.splitlines() for part in (textwrap.wrap(line, width=87) or [''])]
        height = 32 * len(wrapped) + 38
        draw.rounded_rectangle((64, y, 1136, y + height), radius=14, fill='white', outline='#d5dcde', width=1)
        for line in wrapped:
            draw.text((87, y + 20), line, font=font(22), fill='#27383c')
            y += 32
        y += 57
    if y > 938:
        raise RuntimeError('Preview content overflows; shorten the recorded selection')
    draw.line((64, 949, 1136, 949), fill='#d5dcde', width=1)
    draw.text((64, 971), 'Recorded local e2e output. Documentation preview, not a separate product interface.', font=font(17), fill='#556366')
    im.save(output / filename)

render('setup.png', 'Background indexing across projects', 'Session hooks register folders; one daemon owns the watchers and queue.', [
    ('1 / Selected documentation', ['folders: ' + json.dumps(record['config']['folders']),
        'extensions: ' + json.dumps(record['config']['extensions']),
        'exclude: ' + json.dumps(record['config']['exclude'])]),
    ('2 / Project index after watcher processing', [f"index: {record['status']['index']}",
        f"indexed: {record['status']['indexed']}", f"pending: {record['status']['pending']}"]),
    ('3 / Shared recovery state', ['tmp / semantic-search-<user-id> / servers / index-queue.json',
        'Active and waiting file paths; startup reconciles source hashes.',
        'Repeated checks reuse unchanged embeddings.']),
])
result = record['result']
render('search.png', 'Search meaning, read the source', 'Multilingual retrieval uses the prepared project index.', [
    ('Question', [record['query']]),
    ('Top result', [result['path'], f"Lines {result['fromLine']}-{result['toLine']} / {result['heading']}", result['text']]),
    ('Freshness contract', ['Search waits for this project\'s known jobs.',
        'Later edits may remain pending; docs_index explicitly reconciles hashes.',
        'docs_read returns current source lines.']),
])
