import json, sys, pyarrow.parquet as pq
t = pq.read_table(sys.argv[1]).to_pylist()
with open(sys.argv[2], 'w') as f:
    for r in t:
        f.write(json.dumps(r) + '\n')
print(len(t), sorted(t[0].keys()))
