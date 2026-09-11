import { AppState } from 'react-native';
import {
  fetchBillingStatus,
  submitAppleTransaction,
  purchasePro,
  restorePro,
  deliverPendingPurchases,
  startPurchaseDelivery,
  BillingError,
} from '../billing';
import { accessToken, DeviceAuthError } from '../auth';
import {
  getProduct,
  purchaseProduct,
  restorePurchases,
  unfinishedTransactions,
  finishTransaction,
  PRO_MONTHLY_PRODUCT_ID,
} from '../storekit';
import { loadSession } from '../session';

jest.mock('../auth', () => {
  class FakeDeviceAuthError extends Error {
    code: 'device_not_enrolled' | 'device_revoked';
    constructor(reason: 'device_not_enrolled' | 'device_revoked') {
      super('This phone is not signed in yet.');
      this.code = reason;
      this.name = 'DeviceAuthError';
    }
  }
  return {
    accessToken: jest.fn(),
    DeviceAuthError: FakeDeviceAuthError,
    unauthorizedError: jest.fn(),
  };
});

jest.mock('../storekit', () => ({
  PRO_MONTHLY_PRODUCT_ID: 'com.takedia.lilypad.pro.monthly',
  getProduct: jest.fn(),
  purchaseProduct: jest.fn(),
  restorePurchases: jest.fn(),
  unfinishedTransactions: jest.fn(),
  finishTransaction: jest.fn(),
  onTransactionsChanged: jest.fn(() => ({ remove: jest.fn() })),
}));

jest.mock('../session', () => ({ loadSession: jest.fn() }));

const accessTokenMock = accessToken as jest.MockedFunction<typeof accessToken>;
const getProductMock = getProduct as jest.MockedFunction<typeof getProduct>;
const purchaseProductMock = purchaseProduct as jest.MockedFunction<typeof purchaseProduct>;
const restorePurchasesMock = restorePurchases as jest.MockedFunction<typeof restorePurchases>;
const unfinishedMock = unfinishedTransactions as jest.MockedFunction<typeof unfinishedTransactions>;
const finishMock = finishTransaction as jest.MockedFunction<typeof finishTransaction>;
const loadSessionMock = loadSession as jest.MockedFunction<typeof loadSession>;
const realFetch = globalThis.fetch;

const STATUS = {
  tier: 'pro' as const,
  productId: PRO_MONTHLY_PRODUCT_ID,
  currentPeriodEndsAt: '2026-09-26T00:00:00.000Z',
};

const PURCHASE = {
  productId: PRO_MONTHLY_PRODUCT_ID,
  originalTransactionId: 'orig-1',
  transactionId: 'txn-1',
  signedTransactionInfo: 'eyJhbGciOiJFUzI1NiJ9.fake.sig',
  environment: 'Sandbox',
  appAccountToken: 'user-1',
};

const SESSION = {
  userId: 'user-1',
  apiBaseUrl: 'https://api.takedia.com',
  signedInAt: 0,
};

/** Let every pending promise settle, not just the next microtask: one drain is
 *  a chain of them, and the re-entrancy guard stays set until it finishes. */
const settle = () => new Promise<void>((resolve) => setImmediate(() => resolve()));

beforeEach(() => {
  accessTokenMock.mockResolvedValue('a-device-token');
  getProductMock.mockResolvedValue({
    productId: PRO_MONTHLY_PRODUCT_ID,
    displayName: 'Lilypad Pro',
    description: 'Remote access',
    displayPrice: '$2.99',
    price: 2.99,
    currencyCode: 'USD',
    hasIntroOffer: true,
    introOfferLabel: '1 month free',
  });
  purchaseProductMock.mockResolvedValue(PURCHASE);
  restorePurchasesMock.mockResolvedValue([PURCHASE]);
  unfinishedMock.mockResolvedValue([]);
  finishMock.mockResolvedValue(true);
  loadSessionMock.mockResolvedValue(SESSION);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  jest.clearAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchBillingStatus', () => {
  it('GETs /billing/status with the device token', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(STATUS));
    globalThis.fetch = fetchMock;

    await expect(fetchBillingStatus('https://api.takedia.com/')).resolves.toEqual(STATUS);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.takedia.com/billing/status');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer a-device-token');
    expect((init.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('surfaces a missing account as DeviceAuthError', async () => {
    accessTokenMock.mockRejectedValue(new DeviceAuthError('device_not_enrolled'));
    globalThis.fetch = jest.fn();

    await expect(fetchBillingStatus('https://api.takedia.com')).rejects.toBeInstanceOf(
      DeviceAuthError,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('throws BillingError on a non-2xx', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
    await expect(fetchBillingStatus('https://api.takedia.com')).rejects.toBeInstanceOf(
      BillingError,
    );
  });
});

describe('submitAppleTransaction', () => {
  it('POSTs { signedTransaction } and returns status', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(STATUS));
    globalThis.fetch = fetchMock;

    await expect(
      submitAppleTransaction('https://api.takedia.com', PURCHASE.signedTransactionInfo),
    ).resolves.toEqual(STATUS);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.takedia.com/billing/apple/transactions');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      signedTransaction: PURCHASE.signedTransactionInfo,
    });
  });
});

describe('purchasePro', () => {
  it('loads the product, purchases, then submits the JWS', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(STATUS));
    globalThis.fetch = fetchMock;

    await expect(purchasePro('https://api.takedia.com')).resolves.toEqual(STATUS);

    expect(getProductMock).toHaveBeenCalledWith(PRO_MONTHLY_PRODUCT_ID);
    // Stamped with the signed-in account, so a delivery that outlives a
    // sign-out cannot be handed to somebody else (L-297).
    expect(purchaseProductMock).toHaveBeenCalledWith(PRO_MONTHLY_PRODUCT_ID, 'user-1');
    expect(
      JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string),
    ).toEqual({ signedTransaction: PURCHASE.signedTransactionInfo });
  });
});

describe('restorePro', () => {
  it('submits every restored JWS', async () => {
    const second = { ...PURCHASE, signedTransactionInfo: 'eyJ.second.sig', transactionId: 'txn-2' };
    restorePurchasesMock.mockResolvedValue([PURCHASE, second]);
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ...STATUS, tier: 'free' }))
      .mockResolvedValueOnce(jsonResponse(STATUS));
    globalThis.fetch = fetchMock;

    await expect(restorePro('https://api.takedia.com')).resolves.toEqual(STATUS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string),
    ).toEqual({ signedTransaction: second.signedTransactionInfo });
  });

  it('throws when this Apple ID has nothing to restore', async () => {
    restorePurchasesMock.mockResolvedValue([]);
    globalThis.fetch = jest.fn();

    await expect(restorePro('https://api.takedia.com')).rejects.toBeInstanceOf(BillingError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

/**
 * Delivery of a purchase that has already been paid for (L-297).
 *
 * The defect: StoreKit was told the purchase had been delivered before
 * Lilypad's server had heard of it. Losing the network, the process or the
 * backend in that interval left a person charged, with a transaction Apple
 * considered handed over and an account that had never heard of it, and no
 * recovery except somehow knowing to press Restore.
 *
 * These are the half that does not need a phone: what gets finished, when, and
 * what happens when the submission fails. The signed-device run is the other
 * half and is recorded in the kanban.
 */
describe('a purchase is finished only once Lilypad has recorded it', () => {
  it('submits, then finishes, in that order', async () => {
    const order: string[] = [];
    globalThis.fetch = jest.fn().mockImplementation(async () => {
      order.push('submit');
      return jsonResponse(STATUS);
    });
    finishMock.mockImplementation(async () => {
      order.push('finish');
      return true;
    });

    await expect(purchasePro('https://api.takedia.com')).resolves.toEqual(STATUS);
    expect(order).toEqual(['submit', 'finish']);
    expect(finishMock).toHaveBeenCalledWith('txn-1');
  });

  it('leaves the transaction unfinished when the server does not record it', async () => {
    // This is the whole defect. An unfinished transaction is offered again; a
    // finished one is gone, and the person is charged for nothing.
    globalThis.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: 'boom' }, 500));

    await expect(purchasePro('https://api.takedia.com')).rejects.toBeInstanceOf(BillingError);
    expect(finishMock).not.toHaveBeenCalled();
  });

  it('does not tell the person their purchase failed, because it did not', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
    await expect(purchasePro('https://api.takedia.com')).rejects.toThrow(/purchase went through/i);
  });
});

describe('the recovery drain', () => {
  it('delivers what Apple still considers undelivered, then finishes it', async () => {
    unfinishedMock.mockResolvedValue([PURCHASE]);
    globalThis.fetch = jest.fn().mockResolvedValue(jsonResponse(STATUS));

    await expect(deliverPendingPurchases('https://api.takedia.com')).resolves.toEqual({
      delivered: 1,
      held: 0,
    });
    expect(finishMock).toHaveBeenCalledWith('txn-1');
  });

  it('holds a delivery the server refuses, so Apple offers it again', async () => {
    unfinishedMock.mockResolvedValue([PURCHASE]);
    globalThis.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: 'down' }, 503));

    await expect(deliverPendingPurchases('https://api.takedia.com')).resolves.toEqual({
      delivered: 0,
      held: 1,
    });
    expect(finishMock).not.toHaveBeenCalled();
  });

  it('does not hand one account purchase to whoever is signed in now', async () => {
    // A delivery that outlived a sign-out. Apple's stamp says whose it is.
    loadSessionMock.mockResolvedValue({ ...SESSION, userId: 'user-2' });
    unfinishedMock.mockResolvedValue([PURCHASE]);
    globalThis.fetch = jest.fn();

    await expect(deliverPendingPurchases('https://api.takedia.com')).resolves.toEqual({
      delivered: 0,
      held: 1,
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(finishMock).not.toHaveBeenCalled();
  });

  it('still delivers a purchase made before the stamp existed', async () => {
    loadSessionMock.mockResolvedValue({ ...SESSION, userId: 'user-2' });
    unfinishedMock.mockResolvedValue([{ ...PURCHASE, appAccountToken: null }]);
    globalThis.fetch = jest.fn().mockResolvedValue(jsonResponse(STATUS));

    await expect(deliverPendingPurchases('https://api.takedia.com')).resolves.toEqual({
      delivered: 1,
      held: 0,
    });
  });

  it('survives a StoreKit that cannot answer at all', async () => {
    unfinishedMock.mockRejectedValue(new Error('no native module'));
    await expect(deliverPendingPurchases('https://api.takedia.com')).resolves.toEqual({
      delivered: 0,
      held: 0,
    });
  });
});

describe('the delivery loop', () => {
  it('drains on launch and again on every return to the foreground', async () => {
    const listeners: ((s: string) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _: string,
      handler: (s: string) => void,
    ) => {
      listeners.push(handler);
      return { remove: jest.fn() };
    }) as never);

    const delivery = startPurchaseDelivery();
    await settle();
    expect(unfinishedMock).toHaveBeenCalledTimes(1);

    listeners.forEach((l) => l('active'));
    await settle();
    expect(unfinishedMock).toHaveBeenCalledTimes(2);

    // Backgrounding is not a trigger; only coming back is.
    listeners.forEach((l) => l('background'));
    await settle();
    expect(unfinishedMock).toHaveBeenCalledTimes(2);

    delivery.stop();
  });

  it('does nothing at all when nobody is signed in', async () => {
    loadSessionMock.mockResolvedValue(null);
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((() => ({ remove: jest.fn() })) as never);

    const delivery = startPurchaseDelivery();
    await settle();
    expect(unfinishedMock).not.toHaveBeenCalled();
    delivery.stop();
  });
});

/**
 * A 409 is an answer about the purchase, not a network failure (L-308).
 *
 * The guard that stops one Apple subscription entitling two accounts makes
 * this reachable, and "check your connection and try again" sends somebody off
 * to fix a connection that is working perfectly.
 */
describe('what a refused claim tells the customer', () => {
  it('names the real reason when the subscription is on another account', async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse({ error: 'already_linked' }, 409));
    await expect(
      submitAppleTransaction('https://api.takedia.com', PURCHASE.signedTransactionInfo),
    ).rejects.toThrow(/another Lilypad account/);
  });

  it('names it for a purchase stamped for somebody else', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: 'wrong_account' }, 409));
    await expect(
      submitAppleTransaction('https://api.takedia.com', PURCHASE.signedTransactionInfo),
    ).rejects.toThrow(/another Lilypad account/);
  });

  it('falls back to something plain when a 409 carries no code it knows', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(jsonResponse({}, 409));
    await expect(
      submitAppleTransaction('https://api.takedia.com', PURCHASE.signedTransactionInfo),
    ).rejects.toThrow(/Could not update your subscription/);
  });
});
