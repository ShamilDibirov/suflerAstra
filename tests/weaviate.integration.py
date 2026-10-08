"""Exercise the worker's real Weaviate calls; deterministic vectors avoid model downloads."""
import sys
import time

sys.path.insert(0, "/app")
import main
import numpy as np

for attempt in range(60):
    try:
        main.ensure_schema()
        break
    except Exception:
        if attempt == 59:
            raise
        time.sleep(1)


class Embedding:
    def encode(self, texts, **kwargs):
        vector = [1.0, 0.2, 0.1, 0.3]
        return np.array(vector if isinstance(texts, str) else [vector for _ in texts])


class Reranker:
    def predict(self, pairs):
        return np.ones(len(pairs))


main.models.update(embed=Embedding(), rerank=Reranker())


def document(org, id, version=1, region="Все регионы"):
    return {"orgId": org, "id": id, "version": version, "region": region,
            "title": "Замена SIM", "blocks": [{"id": "step", "text": "Замена SIM: проверка владельца номера."}]}


documents = [document("a", "global"), document("a", "global", 2),
             document("a", "moscow", region="Москва"),
             document("a", "spb", region="Санкт-Петербург"), document("b", "global", 2)]
for doc in documents:
    assert main.index_document(main.IndexRequest(document=doc))["indexed"] == 1

payload = main.SearchRequest(orgId="a", query="Замена SIM", region="Москва",
                            versions=[{"id": "global", "version": 2},
                                      {"id": "moscow", "version": 1}, {"id": "spb", "version": 1}])
results = main.search(payload)["results"]
assert {(r["documentId"], r["version"]) for r in results} == {("global", 2), ("moscow", 1)}, results
assert len(results) == 2, results  # Same IDs in another organization must not produce duplicates.
assert main.search(main.SearchRequest(orgId="missing", query="SIM", versions=payload.versions))["results"] == []
assert main.search(main.SearchRequest(orgId="a", query="SIM", versions=[]))["results"] == []
print("PASS: real Weaviate schema, batch indexing, hybrid query, organization/version/region filters; deterministic test vectors.")
