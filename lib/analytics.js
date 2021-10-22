// functionality to provide analytics on shops using the app

const path = require('path')
  , moment = require('moment')
  , _ = require('underscore')
  , handy = require('@takinola/handy')
  , shopify = require(path.join(__dirname, 'handy-shopify'))
  ;


exports.getCustomerCounts = getCustomerCounts;

function getCustomerCounts(type, date, pool) {
  return new Promise((resolve, reject)=>{
    const revShare = 0.8; // percentage of revenue kept from each sale
    // get all the plan names and map to each shop
    const plans = handy.system.systemGlobal.getConfig('shopify_app_billing_plans'); // {plan_id1: {name: planName1, price: 0,..}, ...}
    pool.getConnection((err, connection)=>{
      if(err){return reject(new Error('getCustomerCounts: error getting db connection - ' + err.message))}
      const dateBegin = date.startOf('day').format('YYYY-MM-DD HH:mm:ss');
      const dateEnd = date.endOf('day').format('YYYY-MM-DD HH:mm:ss');

      const query = `
        SELECT s4.billing_plan, COUNT(s4.billing_plan) AS quantity
        FROM (
          SELECT shop, start, end, billing_plan
          FROM (
            SELECT shop, start, end, billing_plan
            FROM (
              SELECT s1.shop AS shop, s1.start AS start, s1.end AS end, s1.billing_plan AS billing_plan
              FROM subscriptions AS s1
              INNER JOIN (
                SELECT shop, MAX(start) AS start
                FROM subscriptions
                WHERE start < ${connection.escape(dateEnd)}
                GROUP BY shop
              ) 
              AS s2
              ON s1.shop = s2.shop
              AND s1.start = s2.start
            ) 
            AS s3
            WHERE end > ${connection.escape(dateEnd)}
            OR end IS NULL
          )
          AS s5
          INNER JOIN (
            SELECT id, shopify_plan
            FROM shops
          ) 
          AS s6
          ON s6.id = s5.shop
          AND s6.shopify_plan <> 'cancelled'
          AND s6.shopify_plan <> 'dormant'
          AND s6.shopify_plan <> 'fraudulent'
          AND s6.shopify_plan <> 'frozen'
          AND s6.shopify_plan IS NOT NULL
        ) 
        AS s4
        GROUP BY s4.billing_plan
      `;      
      connection.query(query, (err, results)=>{
        connection.release();
        if(err){return reject(new Error('getCustomerCounts: error making db query - ' + err.message))}
        const reportType_return = type;
        const date_return = date.clone();
        let data_return = {
          customer_count: {
            total: 0,
          },
          mrr: {
            total: 0,
          },
        };
        if(results.length){
          results.forEach((result)=>{
            const planName = plans[result.billing_plan] ? plans[result.billing_plan].name : null;
            data_return['customer_count'][planName] = result.quantity;
            data_return['customer_count'].total += result.quantity;

            const planPrice = plans[result.billing_plan] ? plans[result.billing_plan].price : 0;
            data_return['mrr'][planName] = data_return['mrr'][planName] || 0;
            data_return['mrr'][planName] += (planPrice * result.quantity * revShare);
            data_return['mrr'].total += handy.utility.roundToDecimalPlaces((planPrice * revShare * result.quantity), 2);
          })
        }

        // round all mrr figures to 2 decimal places
        Object.keys(data_return['mrr']).forEach((mrrType)=>{
          data_return['mrr'][mrrType] = handy.utility.roundToDecimalPlaces(data_return['mrr'][mrrType], 2);
        })

        return resolve({reportType_return, data_return, date_return});
      })


    })

    // get latest start rows before end of date
    // group by shop
    // check if end date is NULL or after end of date
  })
}

exports.getCustomerAdds = getCustomerAdds;

function getCustomerAdds(type, date, pool) {
  return new Promise((resolve, reject)=>{
    // get all the plan names and map to each shop
    const plans = handy.system.systemGlobal.getConfig('shopify_app_billing_plans'); // {plan_id1: {name: planName1, price: 0,..}, ...}
    let intermediateResult = {};
    Object.keys(plans).forEach((planId)=>{
      intermediateResult[plans[planId].name] = {id: planId, quantity: 0};
    })

    pool.getConnection((err, connection)=>{
      if(err){return reject('getCustomerAdds: error getting db connection - ' + err.message)}
        // get all accounts that were created on that date
      const dateBegin = date.startOf('day').format('YYYY-MM-DD HH:mm:ss');
      const dateEnd = date.endOf('day').format('YYYY-MM-DD HH:mm:ss');
      let query = 'SELECT id FROM shops WHERE createdate BETWEEN ' + connection.escape(dateBegin) + ' AND ' + connection.escape(dateEnd);

      connection.query(query, (err, results)=>{
        if(err){
          connection.release();
          return reject('getCustomerAdds: error querying db for shops - ' + err.message)
        }

        // get the latest subscription created for each shop on that date
        let promiseArray = [];
        results.forEach(({id})=>{
          promiseArray.push(
            new Promise((resolve1, reject1)=>{
              // get the billing plan for the last subscription for the day the shop was created
              query = 'SELECT billing_plan FROM subscriptions WHERE shop=' + id + ' AND createdate BETWEEN ' +
                connection.escape(dateBegin) + ' AND ' + connection.escape(dateEnd )+ ' ORDER BY createdate DESC LIMIT 1';
              connection.query(query, (err, results)=>{
                if(err){return reject1('getCustomerAdds: error querying db for subscriptions - ' + err.message)}
                if(results.length){
                  const planName = plans[results[0].billing_plan].name;
                  intermediateResult[planName].quantity++;                  
                }
                return resolve1();
              })
            })
          )
        })

        Promise.all(promiseArray)
        .then(()=>{
          connection.release();
          let total = 0;
          Object.keys(intermediateResult).forEach((planName)=>{
            total += intermediateResult[planName].quantity;
          })

          let data_return = {total};
          Object.keys(intermediateResult).forEach((planName)=>{
            data_return[planName] = intermediateResult[planName].quantity;
          })
          return resolve({data_return, reportType_return: type, date_return: date})
        })
        .catch((err)=>{
          connection.release();
          return reject(new Error('getCustomerAdds: error getting customer adds - ' + err.message));
        })
      })
    })    
  })
}


exports.getCustomerLosses = getCustomerLosses;

function getCustomerLosses(type, date, pool) {
  return new Promise((resolve, reject)=>{

    pool.getConnection((err, connection)=>{
      if(err){return reject('getCustomerLosses: error getting db connection - ' + err.message)}
      // get all subscriptions that ended on that date
      // remove any subscriptions for shops that do not have another subscription start later on that date
      const dateBegin = date.clone().startOf('day').format('YYYY-MM-DD HH:mm:ss');
      const dateEnd = date.clone().endOf('day').format('YYYY-MM-DD HH:mm:ss');
      const query = `
        SELECT s4.shop as shop, s4.billing_plan as billing_plan, s4.end as end, s4.start as start
        FROM (
          SELECT s1.shop, s1.billing_plan, s1.end, s1.start, s3.later_start
          FROM subscriptions as s1
          INNER JOIN(
            SELECT shop, MAX(end) as end
            FROM subscriptions
            WHERE end > ${connection.escape(dateBegin)}
            AND end < ${connection.escape(dateEnd)}
            GROUP BY shop
          ) AS s2
          ON s1.shop = s2.shop
          AND s1.end = s2.end

          LEFT JOIN (
            SELECT shop, MAX(start) as start, 'true' as later_start
            FROM subscriptions
            WHERE start > ${connection.escape(dateBegin)}
            AND start < ${connection.escape(dateEnd)}
            GROUP BY shop
          ) AS s3
          ON s1.shop = s3.shop
          AND s1.end >= s3.start
        ) AS s4
        WHERE s4.later_start IS NULL

      `;

      connection.query(query, (err, results)=>{
        connection.release();
        if(err){
          return reject(new Error('getCustomerLosses: error querying db for shops - ' + err.message));
        }
       
        // for each shop id, check if the createtime is less than end minus onboarding time
        let data_return = {
          total: 0,
          churn: 0,
          onboarding_fail: 0
        };
        const reportType_return = type;
        const date_return = date.clone();

        if(!results.length){
          return resolve({data_return, reportType_return, date_return});
        } else {
          // split the losses into churn and onboarding failures
          const onboardingTime = 72; // hours
          let promiseArray = [];
          // results is in format [{shopId, billing_plan, endTime}]
          results.forEach((result)=>{
            promiseArray.push(
              new Promise((resolve1, reject1)=>{
                let lossShop = new shopify.Shop({id: result.shop});
                lossShop.load('id')
                .then(()=>{
                  const createDate = moment(lossShop.createdate);
                  const lossDate = moment(result.end);

                  if(lossDate.clone().subtract(onboardingTime, 'hours').isAfter(createDate)){
                    data_return.churn++;  
                  } else {
                    data_return.onboarding_fail++;
                  }
                  data_return.total++;
                  return resolve1();
                })
              })
            )
          })

          Promise.all(promiseArray)
          .then(()=> resolve({data_return, reportType_return, date_return}))
          .catch((err)=> reject(new Error('getCustomerLosses: error identifying churn - ' + err.message)))
        }
      })
    })
  })
}


exports.getPlanChanges = getPlanChanges;

function getPlanChanges(type, date, pool) {
  return new Promise((resolve, reject)=>{
    // get all the plan names and map to each shop
    const plans = handy.system.systemGlobal.getConfig('shopify_app_billing_plans'); // {plan_id1: {name: planName1, price: 0,..}, ...}
    const dateBegin = date.clone().startOf('day').format('YYYY-MM-DD HH:mm:ss');
    const dateEnd = date.clone().endOf('day').format('YYYY-MM-DD HH:mm:ss');

    pool.getConnection((err, connection)=>{
      if(err){return reject(new Error('getPlanChanges: error making db connection - ' + err.message))}
      const query = `
        SELECT shop, start, end, billing_plan, previous_billing_plan
        FROM (
          SELECT s1.shop as shop, s1.start as start, s1.end as end, s1.billing_plan as billing_plan, s2.previous_billing_plan as previous_billing_plan
          FROM subscriptions as s1
          LEFT JOIN (
            SELECT shop, start, billing_plan as previous_billing_plan
            FROM subscriptions
          ) AS s2
          ON s1.shop = s2.shop
          AND (
            SELECT MAX(start)
            FROM subscriptions as s3
            WHERE s3.shop = s1.shop
            AND s3.start < s1.start
          ) = s2.start
          ORDER BY s1.shop, s1.start
        ) AS s4
        WHERE s4.start > ${connection.escape(dateBegin)}
        AND s4.start < ${connection.escape(dateEnd)}
        AND s4.previous_billing_plan IS NOT NULL
      `;

      connection.query(query, (err, results)=>{
        connection.release();
        if(err){return reject(new Error('getPlanChanges: error making db query - ' + err.message))}
        let data_return = {total: 0};
        if(results.length){
          results.forEach((result)=>{
            const planBefore = plans[result.previous_billing_plan] ? plans[result.previous_billing_plan].name : null;
            const planAfter = plans[result.billing_plan] ? plans[result.billing_plan].name : null;
            if(planBefore !== planAfter){
              data_return[planBefore + ' to ' + planAfter] = data_return[planBefore + ' to ' + planAfter] || 0;
              data_return[planBefore + ' to ' + planAfter]++;
              data_return.total++;
            }
          })
        }

        const reportType_return = type;
        const date_return = date.clone();
        return resolve({reportType_return, data_return, date_return})
      })
    })
  })
}

