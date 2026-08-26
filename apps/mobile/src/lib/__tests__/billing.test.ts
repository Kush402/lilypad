import {
  fetchBillingStatus,
  submitAppleTransaction,
  purchasePro,
  restorePro,
  BillingError,
} from '../billing';
import { accessToken, DeviceAuthError } from '../auth';
import { getProduct, purchaseProduct, restorePurchases, PRO_MONTHLY_PRODUCT_ID } from '../storekit';

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
}));

const accessTokenMock = accessToken as jest.MockedFunction<typeof accessToken>;
const getProductMock = getProduct as jest.MockedFunction<typeof getProduct>;
const purchaseProductMock = purchaseProduct as jest.MockedFunction<typeof purchaseProduct>;
const restorePurchasesMock = restorePurchases as jest.MockedFunction<typeof restorePurchases>;
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
};

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
    expect(purchaseProductMock).toHaveBeenCalledWith(PRO_MONTHLY_PRODUCT_ID);
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
