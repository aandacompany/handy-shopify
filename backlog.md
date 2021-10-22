# Backlog

## Development
* 

## Documentation
* addPostAppInstallFunctions - adds functions (promises really) that will be executed whenever a new shop installs the app.  Functions can use 'this' in the context of the shop

* systemGlobal 'internal_url_request_hash_validation' enables bypassing of normal validation checks.  This is useful when creating an internal redirect to a path that would normally require a Shopify request validation (e.g. app proxy or webhook).  It is accommplished by creating a cryptographically random hash that is stored in the 'internal_url_request_hash_validation' array.  Upon receipt of redirection, there is a check for query parameter 'handy-shopify-url-validation-hash'. If this exists and is available in the system global then the request bypasses all other regular validation.

* After installation is complete, user is redirected to '/handy/shopify/admin?active_tag=settings&handy_shopify_url_validation_hash=<computed_hash>'.  The idea is to redirect the user to the settings page of the Shopify app within the Shopify dashboard.  This means the app needs to create this route and also ensure it includes the Shopify embedded SDK javascript which will redirect the path into an iframe inside the Shopify dashboard  

## Warning


## Status
