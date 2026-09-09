#!/usr/bin/env python3
"""Optional schema gate; requires installed Draft 2020-12 jsonschema support."""
import json
from pathlib import Path
from jsonschema import Draft202012Validator
root=Path(__file__).resolve().parent
schema=json.loads((root/'schema.json').read_text())
Draft202012Validator.check_schema(schema)
positive=0
for line in (root/'vectors.jsonl').read_text().splitlines():
    vector=json.loads(line)
    if not vector['valid']:continue
    target={'run':'Run','publicResult':'PublicResult'}.get(vector['kind'])
    selected=dict(schema)
    if target:
        selected.pop('oneOf')
        selected['$ref']='#/$defs/'+target
    Draft202012Validator(selected).validate(vector['value'])
    positive+=1
print(f'Evaluation service schema: {positive} positive vectors passed')
