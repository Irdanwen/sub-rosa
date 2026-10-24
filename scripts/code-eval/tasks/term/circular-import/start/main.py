from shop import Order, price_order

order = Order()
order.add("tea", 2, 4.5)
order.add("cup", 1, 12.0)
print(price_order(order))
