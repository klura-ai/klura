// Graph registry — the single map from GraphName to Graph definition. New
// graphs land here as one new file in graphs/ and one entry in this map.

import type { Graph, GraphName } from '../types';
import { DISCOVER_GRAPH } from './discover';
import { MAP_GRAPH } from './map';
import { EXECUTE_GRAPH } from './execute';

export const GRAPHS: Readonly<Record<GraphName, Graph>> = {
  discover: DISCOVER_GRAPH,
  map: MAP_GRAPH,
  execute: EXECUTE_GRAPH,
};

export function graphFor(name: GraphName): Graph {
  return GRAPHS[name];
}
