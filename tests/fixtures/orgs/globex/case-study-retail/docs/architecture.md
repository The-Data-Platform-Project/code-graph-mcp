# Architecture of the retail rollout

The storefront (`acme/shop-web`) calls `acme/shop-api`, which publishes order
events consumed by `globex/analytics`.

See also the decision record on the queue choice.
