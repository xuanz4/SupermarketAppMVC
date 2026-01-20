const axios = require('axios');

const NETS_API = 'https://sandbox.nets.openapipaas.com/api/v1/common/payments/nets-qr/request';
const NETS_QUERY_API = 'https://sandbox.nets.openapipaas.com/api/v1/common/payments/nets-qr/query';
const DEFAULT_TXN_ID = 'sandbox_nets|m|8ff8e5b6-d43e-4786-8ac5-7accf8c5bd9b';

const getCourseInitIdParam = () => {
    try {
        require.resolve('../course_init_id');
        const { courseInitId } = require('../course_init_id');
        return courseInitId ? `${courseInitId}` : '';
    } catch (error) {
        return '';
    }
};

const requestQrCode = async (amount) => {
    const requestBody = {
        txn_id: DEFAULT_TXN_ID,
        amt_in_dollars: amount,
        notify_mobile: 0
    };

    const response = await axios.post(NETS_API, requestBody, {
        headers: {
            'api-key': process.env.API_KEY,
            'project-id': process.env.PROJECT_ID
        }
    });

    return response.data;
};

const buildWebhookUrl = (txnRetrievalRef) => {
    const courseInitId = getCourseInitIdParam();
    return {
        webhookUrl: `https://sandbox.nets.openapipaas.com/api/v1/common/payments/nets/webhook?txn_retrieval_ref=${txnRetrievalRef}&course_init_id=${courseInitId}`,
        courseInitId
    };
};

const queryPaymentStatus = async (txnRetrievalRef, frontendTimeoutStatus = 0) => {
    const response = await axios.post(NETS_QUERY_API, {
        txn_retrieval_ref: txnRetrievalRef,
        frontend_timeout_status: frontendTimeoutStatus
    }, {
        headers: {
            'api-key': process.env.API_KEY,
            'project-id': process.env.PROJECT_ID,
            'Content-Type': 'application/json'
        }
    });

    return response.data;
};

module.exports = {
    requestQrCode,
    buildWebhookUrl,
    queryPaymentStatus
};
