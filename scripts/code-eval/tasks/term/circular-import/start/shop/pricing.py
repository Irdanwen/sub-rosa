from .orders import Order

TAX_RATE = 0.077


def price_order(order: Order) -> float:
    """Total with tax, rounded to cents."""
    subtotal = sum(quantity * unit_price for _, quantity, unit_price in order.lines)
    return round(subtotal * (1 + order.tax_rate()), 2)
