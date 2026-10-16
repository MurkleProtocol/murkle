// Import this before web/src/views/app-mine.js in a test that runs outside Vite (see ./lab-virtual-loader.mjs).
import { register } from "node:module";

register("./lab-virtual-loader.mjs", import.meta.url);
