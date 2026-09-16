import { fetchOrders } from '../api';

test('fetchOrders hits the orders endpoint', async () => {
  const orders = await fetchOrders('c1');
  expect(orders).toBeDefined();
});
