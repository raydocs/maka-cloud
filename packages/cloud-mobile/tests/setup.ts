// A secure store that lives in memory: the tests never touch a real Keychain.
const mockStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  __esModule: true,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-this-device-only',
  isAvailableAsync: async () => true,
  getItemAsync: async (key: string) => mockStore.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    mockStore.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    mockStore.delete(key);
  },
  __store: mockStore,
}));

// The fetch the app uses for the event stream is replaced per test.
const mockFetch = jest.fn();
jest.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => mockFetch(...args) }));

(globalThis as { __fetch?: jest.Mock }).__fetch = mockFetch;
(globalThis as { __secure?: Map<string, string> }).__secure = mockStore;

beforeEach(() => {
  mockStore.clear();
  mockFetch.mockReset();
});

// The tests run as a phone set to English unless a test picks Chinese (`LanguageProvider`).
jest.mock('expo-localization', () => ({
  __esModule: true,
  getLocales: () => [{ languageTag: 'en-US', languageCode: 'en' }],
}));

// The real provider renders nothing until the native side reports the window, which never happens here.
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

// The phone's notifications: nothing native runs in the tests. Each test sets what the phone says.
const mockNotifications = {
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  AndroidImportance: { HIGH: 4 },
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => null),
  setNotificationCategoryAsync: jest.fn(async () => null),
  getPermissionsAsync: jest.fn(async () => ({ granted: false })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
  getExpoPushTokenAsync: jest.fn(async () => ({
    type: 'expo',
    data: 'ExponentPushToken[test-phone-0001]',
  })),
  dismissNotificationAsync: jest.fn(async () => undefined),
  clearLastNotificationResponse: jest.fn(),
  useLastNotificationResponse: jest.fn(() => undefined),
};
jest.mock('expo-notifications', () => mockNotifications);
(globalThis as { __notifications?: typeof mockNotifications }).__notifications = mockNotifications;
beforeEach(() => {
  for (const value of Object.values(mockNotifications)) {
    if (typeof value === 'function' && 'mockClear' in value) value.mockClear();
  }
});
