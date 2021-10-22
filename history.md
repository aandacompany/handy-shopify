# History

## v 7.0.34
- specified app bridge SDK version

## v 7.0.30
- added try catch in validation of access scopes to address scenario where shop is not installed

## v 7.0.29
- added functionality to get list of access scopes for installed app
- added functionality to request additional access scopes

## v 7.0.27
- reverting console logs

## v 7.0.26
- troubleshooting update to see why /configuration/shopify is not loading

## v 7.0.25
- added handy-shopify/getAsset
- removed references to req.session.shop to fully update to using session tokens
- upgraded build components
- added functionality to update orders with REST api

## v 7.0.24
- deprecated handy-shopify/createShopSession as it is no longer required when using session tokens

## v 7.0.18
- fixed bug in Shopify session token verification

## v 7.0.15
- fixed bugs.  no new functionality

## v 7.0.8
- modified /views/components/shopify_app.pug to access getSessionToken to enable token based auth
- added functionality to decode Shopify session tokens

## v 7.0.7
- modified handy-shopify/getProductVariant to return inventory items if requested
- added handy-shopify/adjustVariantInventory to add/remove inventory for variants
- upgraded the following APIs to use GraphQL endpoint
...handy-shopify/getOrders

## v 7.0.3
- upgraded the following APIs to use GraphQL endpoint
...handy-shopify/getCustomers
...handy-shopify/updateCustomer


## v 7.0.1
- limited API version selection to last 4 versions
- upgraded to pug 3.0.0
- removed index on table Shops from column shopify_store_id as it is rarely used
- added index on table Shops to column myshopify_domain
- upgraded the following APIs to use GraphQL endpoint

...handy-shopify/createProduct
...handy-shopify/getProducts
...handy-shopify/createProductVariant
...handy-shopify/updateProductVariant
...handy-shopify/getAllProductVariants
...handy-shopify/getProductVariant
...handy-shopify/createScriptTags
...handy-shopify/createWebhooks

## v 6.6.17
- updated styling of admin header banner

## v 6.6.16
- enabled shop.getProducts to return a streaming response

## v 6.6.15
- fixed bug in shop.getBillingPlans where plans with id=0 where never returned

## v 6.6.14
- updated shop.getOrders to consider fulfillment status

## v 6.6.13
- moved require path before path is first called

## v 6.6.12
- added shopify require to location.js
- structured promise correctly in location.connectInventory

## v 6.6.11
- added require to location.js

## v 6.6.10
- modified location connectInventory to run promises in sequence in order to maintain access to this object

## v 6.6.9
- removed unused order history collection from /shoplist path

## v 6.6.8
- extended shop.resetWebhook to take into account both the default webhooks set by the app and those provided by handy-shopify

## v 6.6.7
- fix bug where taskqueue processing of shop uninstall fails if the shop subscription has already been ended

## v 6.6.5
- truncate shop.money_format if value returned is too long to be stored in database

## v 6.6.4
- modify webhook authentication to return 200 if authentication fails so the sender stops sending requests
- modified cookie check to be compatible with Safari and Chrome

## v 6.6.3
- troubleshooting update

## v 6.6.2
- modified webhook queue handler to only process unlocked queue items

## v 6.6.1
- modified webhook queue handler to run queue items sequentially rather than in parallel

## v 6.6.0
- added ability to update existing products in Shopify backend

## v 6.5.1
- fixed bug in product.getProductDetail
- added shop.getFulfillmentOrders

## v 6.5.0
- extended location database table to include myshopify_domain

## v 6.4.1
- upgraded expressjs dependencies

## v 6.4.0
- added product module
- ability to get product detail from Shopify
- ability to adjust location inventory

## v 6.3.16
- fixed bugs in shop.getLocationInventory

## v 6.3.12
- fixed bug in shop.getCustomers to properly use pagination
- enabled shop.getLocationInventory to properly use pagination

## v 6.3.11
- fix bug in analytics MRR calculation

## v 6.3.10
- updated analytics to use temporary database pool

## v 6.3.9
- destroy db connections in analytics after use (rather than just release)
- removed console logs

## v 6.3.6
- fixed bug in redact shop data webhook processor

## v 6.3.3
- added redact shop data webhook processor
- added MRR chart to analytics

## v 6.3.2
- fixed shopify api list calculation to provide full list of available API versions

## v 6.3.1
- moved location to separate file

## v 6.3.0
- added shopify analytics

## v 6.2.0
- added suport to find themes
- added support to create assets

## v 6.1.1
- added CDN headers to some paths were it was missing

## v 6.1.0
- register carrier service

## v 6.0.3
- bug fixes

## v 6.0.2
- modified dynamic paths to avoid CDN caching

## v 6.0.1
- modified shop.getLocations to also retrieve locations from the database
- added support for new runtime extensions in handyjs

## v 6.0.0
- added shop.getLocations to retrieve list of locations available to the shop
- moved Order object definition into handy-shopify
- added Location object definition

## v 0.0.2 // 07/09/17
---
Modified to be an NPM module

## v 0.0.1 // 05/08/17
---
Initial release of Handy-Shopify