import { MemoryAsyncStorage } from "../../src/session/storage";

/** Default export mirrors the real package; tests usually inject their own storage. */
const AsyncStorage = new MemoryAsyncStorage();
export default AsyncStorage;
