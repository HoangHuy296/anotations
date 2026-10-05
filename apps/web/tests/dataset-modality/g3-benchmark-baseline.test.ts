import "../../../../scripts/db-safety/test-entry.cjs";
import test from "node:test";
import { benchmark } from "./g3-benchmark-support";
test("G3 baseline matched workloads",{timeout:600000},()=>benchmark("baseline"));
