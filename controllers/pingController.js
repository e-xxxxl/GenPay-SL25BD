exports.ping = async (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Server is awake',
  });
};
