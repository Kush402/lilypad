import { configure } from '@testing-library/react-native';

/**
 * How long `findBy*` / `waitFor` may wait before giving up.
 *
 * The library's default is one second, and one second is a statement about the
 * machine, not about the code. `AccountDevicesScreen.test.tsx` mounts a full
 * react-navigation stack, a native-stack screen and a FlatList before its first
 * assertion; on an idle laptop that lands in ~200 ms, and on a loaded CI runner
 * it does not. It failed exactly once on `main`'s CI with
 *
 *   Unable to find an element with text: /Work MacBook/
 *
 * while passing every time locally — which is the worst kind of red, because it
 * teaches people to press re-run instead of read.
 *
 * Raising the budget weakens nothing: `findByText` returns the moment the
 * element appears, so a healthy run is exactly as fast as before and only a
 * genuinely absent element pays the full wait. A test that fails because the
 * runner was busy is not reporting a defect. Same reasoning, and the same
 * number, as the twenty-second deadlines in `src-tauri/tests/input_worker.rs`.
 */
configure({ asyncUtilTimeout: 15_000 });
