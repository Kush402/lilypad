import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { AppLifecycleController } from './lifecycle';

// `@react-native-community/netinfo` has native bindings with no jest preset
// mock of its own (unlike `AppState`, which ships one in the RN jest preset —
// see `node_modules/react-native/jest/setup.js`) — mock it locally so
// `addEventListener` is a plain, inspectable jest.fn().
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn() },
}));

function lastAppStateHandler(): (next: string) => void {
  const calls = (AppState.addEventListener as jest.Mock).mock.calls;
  return calls[calls.length - 1][1];
}

function lastNetInfoHandler(): (state: { isConnected: boolean }) => void {
  const calls = (NetInfo.addEventListener as jest.Mock).mock.calls;
  return calls[calls.length - 1][0];
}

describe('AppLifecycleController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    (AppState as unknown as { currentState: string }).currentState = 'active';
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function makeCallbacks() {
    return {
      onBackground: jest.fn(),
      onForeground: jest.fn(),
      onNetworkRestored: jest.fn(),
    };
  }

  it('subscribes to AppState and NetInfo on construction', () => {
    new AppLifecycleController(makeCallbacks());
    expect(AppState.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    expect(NetInfo.addEventListener).toHaveBeenCalledWith(expect.any(Function));
  });

  it('fires onBackground only after the debounce window elapses', () => {
    const cb = makeCallbacks();
    new AppLifecycleController(cb);
    const handleAppState = lastAppStateHandler();

    handleAppState('background');
    expect(cb.onBackground).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1_999);
    expect(cb.onBackground).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(cb.onBackground).toHaveBeenCalledTimes(1);
  });

  it('a quick background-then-foreground bounce within the debounce window fires neither callback', () => {
    const cb = makeCallbacks();
    new AppLifecycleController(cb);
    const handleAppState = lastAppStateHandler();

    handleAppState('inactive'); // e.g. iOS control-center swipe
    jest.advanceTimersByTime(500);
    handleAppState('active');

    jest.advanceTimersByTime(5_000);
    expect(cb.onBackground).not.toHaveBeenCalled();
    expect(cb.onForeground).not.toHaveBeenCalled();
  });

  it('fires onForeground when returning to active after a real (debounced) background', () => {
    const cb = makeCallbacks();
    new AppLifecycleController(cb);
    const handleAppState = lastAppStateHandler();

    handleAppState('background');
    jest.advanceTimersByTime(2_000); // debounce fires, onBackground called
    expect(cb.onBackground).toHaveBeenCalledTimes(1);

    handleAppState('active');
    expect(cb.onForeground).toHaveBeenCalledTimes(1);
  });

  it('does not fire onNetworkRestored for the initial NetInfo callback', () => {
    const cb = makeCallbacks();
    new AppLifecycleController(cb);
    const handleNetInfo = lastNetInfoHandler();

    handleNetInfo({ isConnected: true });
    expect(cb.onNetworkRestored).not.toHaveBeenCalled();
  });

  it('fires onNetworkRestored only on a disconnected → connected transition', () => {
    const cb = makeCallbacks();
    new AppLifecycleController(cb);
    const handleNetInfo = lastNetInfoHandler();

    handleNetInfo({ isConnected: true });
    handleNetInfo({ isConnected: false });
    expect(cb.onNetworkRestored).not.toHaveBeenCalled();

    handleNetInfo({ isConnected: true });
    expect(cb.onNetworkRestored).toHaveBeenCalledTimes(1);

    // Staying connected must not re-fire.
    handleNetInfo({ isConnected: true });
    expect(cb.onNetworkRestored).toHaveBeenCalledTimes(1);
  });

  it('dispose() unsubscribes from both sources and cancels a pending debounce', () => {
    const cb = makeCallbacks();
    const removeAppState = jest.fn();
    (AppState.addEventListener as jest.Mock).mockReturnValue({ remove: removeAppState });
    const removeNetInfo = jest.fn();
    (NetInfo.addEventListener as jest.Mock).mockReturnValue(removeNetInfo);

    const controller = new AppLifecycleController(cb);
    lastAppStateHandler()('background'); // schedule the debounce timer

    controller.dispose();
    jest.advanceTimersByTime(5_000);

    expect(cb.onBackground).not.toHaveBeenCalled();
    expect(removeAppState).toHaveBeenCalledTimes(1);
    expect(removeNetInfo).toHaveBeenCalledTimes(1);
  });
});
