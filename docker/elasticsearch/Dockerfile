# Lucid - Elasticsearch 8.11 with Korean nori analyzer.
# Used by the Lucid backend for graph adjacency lists, kNN, and Korean
# text search across the personal knowledge graph.
FROM docker.elastic.co/elasticsearch/elasticsearch:8.11.4

# nori is Elasticsearch's official Korean morphological analyzer.
# Installed at image build time so it survives container restarts and
# does not depend on network availability at boot.
RUN bin/elasticsearch-plugin install --batch analysis-nori
