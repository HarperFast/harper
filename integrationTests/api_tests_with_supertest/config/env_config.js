export const global = {
    host: 'http://localhost',
    port: '9925',
    portRest: '9926',
    username: 'admin',
    password: 'admin',
    schema: "northnwd",
    files_location: "/usr/csv/",
    emps_tb: "employees",
    emps_id: "employeeid",
    ords_tb: "orders",
    ords_id: "orderid",
    ordd_tb: "order_details",
    ordd_id: "orderid",
    prod_tb: "products",
    prod_id: "productid",
    cust_tb: "customers",
    cust_id: "customerid",
    cate_tb: "categories",
    cate_id: "categoryid",
    supp_tb: "suppliers",
    supp_id: "supplierid",
    ship_tb: "shippers",
    ship_id: "shipperid",
    empt_tb: "employeeterritories",
    empt_id: "employeeid",
    terr_tb: "territories",
    terr_id: "territoryid",
    regi_tb: "region",
    regi_id: "regionid",
    user_id: "",
    test_user_name: "test_user",
    role_id: "fa05a5b8-b505-4bef-83e5-873ff53e6f67",
    job_id: "",
    next_request: "",
    "function:getJobId": "",
    cluster_user_role_id: "6b5347c9-7ca5-4263-885a-0762e53b5714",
    insert_timestamp: "0",
    csv_tb: "url_csv_data",
    csv_tb_empty: "url_csv_no_data",
    drop_schema: "drop_schema",
    drop_table: "drop_table",
    s3_key: "AKIA25KWWUK6PJNH7FW3",
    s3_secret: "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"
}

export const url = global.host + ':' + global.port;

export const headers = {
        // Authorization: 'Basic ' + encodeCredentials(),
        // No need to set header content-type as it comes from the server as application/json
        'Content-Type': 'application/json'
}