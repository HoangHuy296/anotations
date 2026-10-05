import "../../../../scripts/db-safety/test-entry.cjs";
import test from "node:test";
import { contention } from "./g3-contention-support";
test("G3 baseline contention investigation",{timeout:900000},()=>contention("baseline"));
