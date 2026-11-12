package com.example.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.EmojiEvents
import androidx.compose.material.icons.filled.Key
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.model.Tournament
import com.example.ui.theme.*

@Composable
fun TournamentsScreen(
    tournaments: List<Tournament>,
    onCreateTournament: (title: String, fee: Double, prize: Double, time: String) -> Unit,
    onUpdateRoom: (id: String, roomId: String, roomPass: String) -> Unit
) {
    var showCreateDialog by remember { mutableStateOf(false) }
    var selectedTournamentForRoom by remember { mutableStateOf<Tournament?>(null) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "TOURNAMENT MANAGEMENT",
                color = GoldPrimary,
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.sp
            )

            Button(
                onClick = { showCreateDialog = true },
                colors = ButtonDefaults.buttonColors(containerColor = GoldPrimary),
                shape = RoundedCornerShape(10.dp),
                modifier = Modifier.testTag("btn_create_tournament")
            ) {
                Icon(Icons.Default.Add, contentDescription = null, tint = OnGold, modifier = Modifier.size(16.dp))
                Spacer(modifier = Modifier.width(6.dp))
                Text("New Match", color = OnGold, fontSize = 12.sp, fontWeight = FontWeight.Bold)
            }
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            items(tournaments) { t ->
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(14.dp),
                    colors = CardDefaults.cardColors(containerColor = BgCard),
                    border = androidx.compose.foundation.BorderStroke(1.dp, GoldLineSubtle)
                ) {
                    Column(modifier = Modifier.padding(14.dp)) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Default.EmojiEvents, contentDescription = null, tint = GoldPrimary, modifier = Modifier.size(24.dp))
                                Spacer(modifier = Modifier.width(10.dp))
                                Column {
                                    Text(t.title, color = TextMain, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                                    Text("${t.game} • ${t.type} • ${t.map}", color = TextMuted, fontSize = 11.sp)
                                }
                            }

                            Surface(
                                color = if (t.status == "Live") AccentRed.copy(alpha = 0.15f) else SuccessGreen.copy(alpha = 0.15f),
                                shape = RoundedCornerShape(50)
                            ) {
                                Text(
                                    text = t.status.uppercase(),
                                    color = if (t.status == "Live") AccentRed else SuccessGreen,
                                    fontSize = 10.sp,
                                    fontWeight = FontWeight.Bold,
                                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 3.dp)
                                )
                            }
                        }

                        Spacer(modifier = Modifier.height(10.dp))

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Column {
                                Text("Entry Fee", color = TextMuted, fontSize = 11.sp)
                                Text("৳ ${t.entryFee}", color = GoldPrimary, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                            }
                            Column {
                                Text("Total Prize", color = TextMuted, fontSize = 11.sp)
                                Text("৳ ${t.prizePool}", color = SuccessGreen, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                            }
                            Column(horizontalAlignment = Alignment.End) {
                                Text("Slots", color = TextMuted, fontSize = 11.sp)
                                Text("${t.joinedCount} / ${t.maxSlots}", color = TextMain, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                            }
                        }

                        Spacer(modifier = Modifier.height(10.dp))

                        // Room details
                        Card(
                            modifier = Modifier.fillMaxWidth(),
                            colors = CardDefaults.cardColors(containerColor = BgInner),
                            shape = RoundedCornerShape(8.dp)
                        ) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 12.dp, vertical = 8.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text(
                                    text = if (t.roomId.isNotBlank()) "Room: ${t.roomId} | Pass: ${t.roomPass}" else "Room Details: Not set yet",
                                    color = if (t.roomId.isNotBlank()) GoldPrimary else TextDim,
                                    fontSize = 11.sp,
                                    fontWeight = FontWeight.SemiBold
                                )

                                Button(
                                    onClick = { selectedTournamentForRoom = t },
                                    colors = ButtonDefaults.buttonColors(containerColor = GoldPrimary),
                                    shape = RoundedCornerShape(6.dp),
                                    contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp)
                                ) {
                                    Icon(Icons.Default.Key, contentDescription = null, tint = OnGold, modifier = Modifier.size(14.dp))
                                    Spacer(modifier = Modifier.width(4.dp))
                                    Text("Set Room", fontSize = 10.sp, color = OnGold, fontWeight = FontWeight.Bold)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if (showCreateDialog) {
        var title by remember { mutableStateOf("") }
        var fee by remember { mutableStateOf("50") }
        var prize by remember { mutableStateOf("1500") }
        var time by remember { mutableStateOf("Today 9:30 PM") }

        AlertDialog(
            onDismissRequest = { showCreateDialog = false },
            title = { Text("Create New Tournament", color = GoldPrimary, fontWeight = FontWeight.Bold) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(value = title, onValueChange = { title = it }, label = { Text("Match Title") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(value = fee, onValueChange = { fee = it }, label = { Text("Entry Fee (BDT)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(value = prize, onValueChange = { prize = it }, label = { Text("Total Prize Pool (BDT)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(value = time, onValueChange = { time = it }, label = { Text("Schedule Time") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        val feeVal = fee.toDoubleOrNull() ?: 0.0
                        val prizeVal = prize.toDoubleOrNull() ?: 0.0
                        if (title.isNotBlank()) {
                            onCreateTournament(title, feeVal, prizeVal, time)
                            showCreateDialog = false
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = GoldPrimary)
                ) {
                    Text("Create", color = OnGold, fontWeight = FontWeight.Bold)
                }
            },
            dismissButton = {
                TextButton(onClick = { showCreateDialog = false }) { Text("Cancel") }
            },
            containerColor = BgSurface
        )
    }

    selectedTournamentForRoom?.let { t ->
        var roomId by remember { mutableStateOf(t.roomId) }
        var roomPass by remember { mutableStateOf(t.roomPass) }

        AlertDialog(
            onDismissRequest = { selectedTournamentForRoom = null },
            title = { Text("Set Room ID & Password", color = GoldPrimary, fontWeight = FontWeight.Bold) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(t.title, color = TextMain, fontSize = 12.sp)
                    OutlinedTextField(value = roomId, onValueChange = { roomId = it }, label = { Text("Custom Room ID") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(value = roomPass, onValueChange = { roomPass = it }, label = { Text("Room Password") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        onUpdateRoom(t.id, roomId, roomPass)
                        selectedTournamentForRoom = null
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = GoldPrimary)
                ) {
                    Text("Save Room", color = OnGold, fontWeight = FontWeight.Bold)
                }
            },
            dismissButton = {
                TextButton(onClick = { selectedTournamentForRoom = null }) { Text("Cancel") }
            },
            containerColor = BgSurface
        )
    }
}
