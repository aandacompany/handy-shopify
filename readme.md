# Handy-Shopify.js Documentation

## Introduction

## Features

## Dependencies

## Getting Started

### Globals
Globals are set using handy.system.systemGlobal.set(global_name, global_value)

#### shopify_custom_app
If true, indicates the app is a custom app.  Used to bypass functionality that is only applicable to public apps eg billing selection

#### handy_shopify_default_webhooks
Array of webhooks always set upon installation in the shop (typically, shop/update and shop/uninstall)



## API Documentation

### Module: handy-shopfy

#### addPostAppInstallFunctions
Adds new functions that are executed whenever the app is installed on a shop.  The functions must return promises and are executed in the context of the shop “this” object

_arguments_ 

* @param {array} functionArray - array of functions to be executed 

_example_ 

```js
addPostAppInstallFunctions([function_a, function_b,....])
```


#### authenticateJWT
Middleware to authenticate calls from front end using JWT
Used to authenticate calls from interfaces embedded inside the Shopify admin

_arguments_
* @param {object} req - express request object
* @param {object} res - express response object
* @param {function} next - express next object

_example_
```js
let shopifyAdminRouter = express.router

shopifyAdminRouter.use(authenticateJWT)
shopifyAdminRouter.post('/random_path', (req, res)=>{})
```


#### Shop
This is the Shop class.  It is based on the handy baseObject

Shop objects have the following properties (in addition to those inherited from the handy baseObject)
_insert property list_

Shop objects have the following methods


##### getAccessScopes
Get list of all access scopes for currently installed app

_arguments_
None

_example_
```js
let shop = new Shop(...)
const scopes = await shop.getAccessScopes();
// scopes = ['read_theme', 'write_themes', ...]

```


##### validateAccessScopes
Middleware to validate shop has all the current access scopes

_arguments_
* @param {object} req - Express request object
* @param {object} res - Express response object
* @param {object} next - Express next object

_example_
```js
app.get('/settings', validateAccessScopes, (req, res)=>{
  const myshopify_domain = req.query.shop;  // it is important that the myshopify domain is included in the req.query.shop value
})

```



##### getThemes
Gets all themes available in the shop

_arguments_
* @param {object} {current} - if true, returns only the published theme otherwise returns all themes

_example_
```js
let shop = new Shop(...)
let current = true
shop.getThemes({current})
.then((currentTheme)=> /.../)
```


##### createAsset
Creates an (or updates an existing) asset in the shop theme

_arguments_
* @param {object} asset - asset to be created.  format {key: 'eg snippet/my_file.liquid', value: 'eg content of file'}
* @param {string} themeId - id of the theme where the asset will be created

_example_
```js
let shop = new Shop(...)
const asset = {
  key: 'snippet/my_file.liquid',
  value: '{{ this is my file }}'
}
const themeId = '124567'
shop.createAsset(asset, themeId)
.then((createdAsset)=> /.../)
```


##### getAsset
Get asset from the shop theme

_arguments_
* @param {string} key - key of the asset eg "snippet/my_file.liquid"
* @param {string} themeId - id of the theme where the asset is located

_example_
```js
let shop = new Shop(...)
const key = 'snippet/my_file.liquid'
const themeId = '1234567'
shop.getAsset(key, themeId)
.then((asset)=> /../)
```


##### createScriptTags
Adds script tags to designated shop.  This function needs to be bound to the shop that is creating script tags.  If using REST API, createShopifyAPI needs to have been run on the shop before calling this function

_arguments_
* @param {array} scriptTags - script tags to be created
* @param {bool} gql - if true, use the GraphQL API

_example_
```js
let shop = new Shop(...)
const gql = true;
createScriptTags.bind(shop)([
    {
      script_tag: {
        name: 'my tag',
        display_scope: 'ONLINE_STORE',
        src: 'https://path/to/script.js'
      }
    },
    {
      script_tag: {
        name: 'my other tag',
        display_scope: 'ALL',
        src: 'https://path/to/other/script.js'
      }
    }
  ],
  gql)

  // shop.app_settings.scripttags will contain the array of all active script tags
```


##### createWebhooks
Adds webhooks to the designated shop.  This function needs to be bound to the shop that it is creating webhooks on.  Also, createShopifyAPI needs to have been run on the shop before calling this function

_arguments_ 

* @param {object} webhooks - webhooks to be created
* @param {bool} gql - if yes, use GraphQL API

_example_ 

```js
let shop = new Shop(...) 

// GraphQL API example
const gql = true;
createWebhooks.bind(shop)({
  webhook: {
    topic: 'ORDER_CREATE',
    address: 'https://path/webhook/should/call',
    format: 'JSON'
  }
}, gql)


// REST API example
createWebhooks.bind(shop)({
  webhook: {
    topic: ‘orders/create’,
    address: ‘https://path/webhook/should/call’,
    format: ‘json’
  }
})


// shop.app_settings.webhooks will contain the array of active webhooks
```



##### resetWebhooks
This recreates the Shopify webhooks for the shop.  This is sometimes necessary if the Shopify webhook creation process fails at installation or if new webhooks are to be added to the shop (by updating the 'shopify_default_webhooks' system variable)

_arguments_ 

none

_example_ 

```js
let shop = new Shop(...)
shop.resetWebhooks()
```


##### getOrders
This fetches orders from Shopify

_arguments_
* @param {int} orderId - if provided, will retrieve the particular order with that id (not valid for GraphQL API)
* @param {string} fulfilment_status - if provided will retrieve only orders with that fulfillment status.  defaults to 'unfulfilled'
* @param {boolean} stream - if true, the data will be provided as a stream in chuncks
* @param {boolean} gql - if true, use GraphQL API
* @params {array} fields - fields to be returned if using GraphQL API.  child customer and line item fields should be prefixed with "customer__" and "line_items__" respectively
* NOTE: field line items will return data in format 
* lineItems {
    edges {
      node {
        ...requested fields
      }
    }
  }

_example_
```js
let shop = new Shop(...)
shop.getOrders(null, 'partial')

or
const stream = true;
const orderGetter = shop.getOrders(null, null, stream)
const delimiter = '!@$%^&*()';
handy.system.sendData(orderGetter, delimiter, res)
.then(()=> / continue processing /)
.catch((err)=> / error processing /)

or

const gql = true
const fields = ['id', 'name', 'shippingAddress', 'customer__displayName', 'line_items__id']
const orderId = "gid://shopify/order/123456"
shop.getOrders(orderId, null, null, gql, fields)
.then((orders)=> /.../)

```


##### updateOrder
Update existing order
NOTE: Only editing with the REST API is enabled

_arguments_
* @param {string} id - order id
* @param {object} order - order object with required parameters
* @param {boolean} gql - if true, use GraphQL

_example_
```js
let shop = new Shop(...)
const id = '1234567'
const order = {
  id: '1234567',
  note_attributes: {
    name: 'new attribute',
    value: 'i changed'
  }
}

shop.updateOrder({id, order})
.then((updatedOrder)=> / continue processing /)
.catch((err)=> / error processing /)

```


##### createProduct
Create a product in the shop

_arguments_
* @param {object} productDefinition - object with the product properties
* @param {array} fields - fields to be returned if using GraphQL API
* @param {bool} gql - if true, use GraphQL API

_example_
```js
let shop = new Shop(...)

const productDefinition = {
  title: 'my product',
  bodyHtml: '<p>Please buy this amazing product</p>',
  vendor: 'Seller Co'
}

const fields = ['id', 'handle', 'tags']
const gql = true

shop.createProduct(productDefinition, fields, gql)
.then(product => /.../)

```

##### getProducts
Retrieve the list of products in the shop

_arguments_
* @params {array} fields - fields to be returned for each product object 
* NOTE: prefixing fields with "variant__" will get the variant fields.  Requesting variant fields will slow down the query considerably
* @params {array} ids - if provided, only the products with these specific ids will be returned
* @params {string} handle - if provided, only the product with this handle will be returned
* @params {string} product_type - if provided, only products with this product type will be returned
* @params {bool} stream - if true, the data will be provided as a stream in chuncks
* @params {bool} gql - if true, use GraphQL API
* [GraphQL only] @params {object} filter - key value parameters to filter results


_example_
```js
let shop = new Shop(...)

shop.getProducts({fields: ['id', 'handle'], ids: [1234, 5678], handle: 'cool-product', product_type: 'blockbuster', stream: false})
.then((products)=>{ / process products})
.catch((err)=> { / process errors})

or

const productGetter = shop.getProducts({stream: true})
const delimiter = '!@$%^&*()';
handy.system.sendData(productGetter, delimiter, res)
.then(()=> / continue processing)
.catch((err)=> / error processing)

or

const filter = {product_type: 'blockbuster'}
const fields = ['id', 'title', 'description', 'productType', 'variant__id']
const gql = true            // use GraphQL API
shop.getProducts({fields, filter, gql})
.then((products)=> {/ process products})
.catch((err)=> process errors)

```

##### getProductVariant
Retrieve a specific product variant

_arguments_
* @param {string} id - id of variant to be retrieved
* @param {array} fields - list of fields to be returned if using GraphQL
* NOTE: field inventoryItem will return data in format 
* {inventoryItem 
*   { 
*     id 
*     inventory (first: 100){
*       edges { node
*               id
*               available
*               location {id name isActive shipsInventory}
*             }
*     }
*   }
*  }
* @param {bool} gql - if true, use GraphQL API

_example_
```js
let shop = new Shop(...)

// REST API
const id = '1234'
shop.getProductVariant(id)
.then(variant => / process variant)

// GraphQL API
const id = "gid://shopify/productVariant/123456"
const fields = ['id', 'price', 'title']
const gql = true
shop.getProductVariant(id, fields, gql)
.then(variant => / process variant)
```


##### getAllProductVariants
Retrieve the list of product variants in the shop

_arguments_
* @param {array} fields - fields to be returned for each variant object. child product fields should be prefixed with "product__" eg "product__id"
* @param {object} filter - key value parameters to filter results
* @param {bool} gql - if true, use GraphQL API

_example_
```js
let shop = new Shop(...)

const fields = ['id', 'price', 'title']
const filter = {product_type: 'blockbuster'}
const gql = true;
shop.getAllProductVariants({fields, filter, gql})
.then((variants)=> / process variants)
.catch((err)=> / process errors)
```

##### createProductVariant
Create a product variant

_arguments_
* @params {object} variantDefinition - variant properties
* @params {array} fields - variant fields to be returned
* @params {bool} gql - if true, use GraphQL API

_example_
```js
const fields = ['id', 'price', 'title']
const variantDefinition = {
  price: 10000,
  sku: 'my_variant',
  taxable: true,
  options: 'variant_title'
}

const gql = true;

shop.createProductVariant(variantDefinition, fields, gql)
.then(variant => / process variant)
```

##### updateProductVariant
Update an existing product variant

_arguments_
* @params {object} variantDefinition - new variant properties.  must include id of variant to be updated
* @params {array} fields - variant fields to be returned
* @params {bool} gql - if true, use GraphQL API

_examples_
```js
const fields = ['id', 'price', 'title']
const variantDefinition = {
  price: 20000,
  sku: 'my_variant_updated',
  taxable: true,
  id: "gid://shopify/Variant/123456"
}

const gql = true;

shop.updateProductVariant(variantDefinition, fields, gql)
.then(variant => / process variant)
```


##### adjustVariantInventory
Add or remove inventory for specified variant

_arguments_
* @params {string} variant_id - GraphQL id of variant
* @params {int} available_adjustment - quantity to add (or remove, if negative) from inventory
* NOTE: This method modifies the first active location

_examples_
```js
const variant_id = 'gid://shopify/ProductVariant/123456'
const available_adjustment = 10

const shop = new Shop(...)
shop.adjustVariantInventory(variant_id, available_adjustment)
.then((inventoryLevelId)=> /.../)

```



##### getCustomers
Get the customer details for a shop

_arguments_
* @params {array} fields - customer fields to be returned
* NOTE including the field "metafields" will return all metafields attached to the customer.  Requesting metafields will slow the query down considerably
* @params {array} ids - ids of customers to be returned (when provided for GraphQL, only the customer with the first Id is returned)
* @params {bool} gql - if true, use GraphQL API
* @params {bool} stream - if true, the data will be provided as a stream in chuncks (only available with the GraphQL API)

_examples_
```js
const fields = ['id', 'displayName', 'email']
const gql = true;

const shop = new Shop(...)
shop.getCustomers({fields, gql})
.then((customers)=> / process customers)
```


##### updateCustomer
Update a customer record in Shopify

_arguments_
* @params {object} customer - customer details to be updated
* @params {bool} gql - if true, use GraphQL API

_examples_
```js
const shop = new Shop(...)
const customer = {
  id: 'gid://shopify/Customer/123456789',
  note: 'This is a VIP customer',
  metafields: {
    namespace: 'my app',
    key: 'vip',
    value: 'true',
    valueType: 'STRING',
    id: 'gid://shopify/Metafield/987654321'
  }
}

const gql = true

shop.updateCustomer(customer, gql)
.then((customerRecord)=> / customerRecord === {id} )
```


## How handy-shopifyjs works

## License

## Credits