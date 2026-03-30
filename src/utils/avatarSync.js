const Board = require("../models/Board");

async function syncAvatarAcrossBoards(userId, newAvatarUrl) {
  await Board.updateMany(
    { "members.userId": userId },
    { $set: { "members.$.avatar": newAvatarUrl } }
  );
}

module.exports = syncAvatarAcrossBoards;
